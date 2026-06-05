package com.arara.api.services

import com.arara.api.dto.CheckoutSessionResponse
import com.arara.api.dto.PaymentRequestDTO
import com.arara.api.models.domain.Plan
import com.arara.api.models.domain.PlanRecurrenceType
import com.arara.api.models.domain.Subscription as AraraSubscription
import com.arara.api.models.enums.OrgTrustLevel
import com.arara.api.models.enums.PlanType
import com.arara.api.models.enums.SubscriptionStatus
import com.arara.api.models.repository.OrganizationRepository
import com.arara.api.models.repository.PlanRepository
import com.arara.api.models.repository.SubscriptionRepository
import com.arara.api.models.repository.UserRepository
import com.stripe.Stripe
import com.stripe.exception.StripeException
import com.stripe.model.Price
import com.stripe.model.Product
import com.stripe.model.checkout.Session
import com.stripe.param.PriceCreateParams
import com.stripe.param.ProductCreateParams
import com.stripe.param.checkout.SessionCreateParams
import jakarta.annotation.PostConstruct
import java.math.BigDecimal
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

@Service
@Suppress("LongParameterList")
class StripeService(
        private val planRepository: PlanRepository,
        private val userRepository: UserRepository,
        private val subscriptionRepository: SubscriptionRepository,
        private val walletService: WalletService,
        private val araraPhoneNumberService: AraraPhoneNumberService,
        private val subscriptionLifecycleService: SubscriptionLifecycleService,
        private val walletAutoRechargeService: WalletAutoRechargeService,
        private val accountActivationNotifier: AccountActivationNotifier,
        private val nfIssuanceNotifier: NfIssuanceNotifier,
        private val organizationRepository: OrganizationRepository,
        private val messageQualityGuardService: MessageQualityGuardService,
) {
    @Value("\${stripe.secret.key}") private lateinit var secretKey: String

    @Value("\${spring.profiles.active:default}") private lateinit var activeProfile: String

    private var successUrl: String = "https://ararahq.com/dashboard"
    private var cancelUrl: String = "https://ararahq.com/dashboard/faturamento"

    private val log = LoggerFactory.getLogger(StripeService::class.java)

    companion object {
        // Alinhado com auto-recharge (min R$ 20) pra evitar a situação em
        // que usuário só consegue topar a wallet via auto-recharge (R$ 20)
        // ou via manual com ticket alto (R$ 80+). Bruno Casarini reportou
        // a fricção: queria pagar R$ 20 sem esperar gastar saldo até o
        // threshold do auto-recharge.
        val MINIMUM_RECHARGE_AMOUNT: BigDecimal = BigDecimal(20)
        private const val LIVE_KEY_PREFIX = "sk_live_"
        private val STAGING_PROFILES = setOf("staging", "dev", "test", "local")

        // planKey das linhas de add-on em `plans` (seed em V113). Convenção:
        // SCREAMING_SNAKE, mesma da convenção dos planos principais.
        const val BRAIN_ADDON_KEY = "BRAIN_ADDON"
        const val EXTRA_SEAT_KEY = "EXTRA_SEAT"

        private val TRUSTED_PLAN_TYPES: Set<PlanType> = setOf(
            PlanType.PRO,
            PlanType.ENTERPRISE,
        )
    }

    @PostConstruct
    fun initStripe() {
        val isLive = secretKey.startsWith(LIVE_KEY_PREFIX)
        val isProdProfile = activeProfile == "prod" || activeProfile == "production"
        if (isLive && !isProdProfile) {
            log.error(
                "⚠️  DANGER: stripe.secret.key starts with sk_live_ on profile={}. " +
                    "Real cards WILL be charged. Swap STRIPE_SECRET_KEY to sk_test_* immediately.",
                activeProfile,
            )
        }
        log.info(
            "Inicializando Stripe. [keyPrefix={}, profile={}]",
            secretKey.take(7), activeProfile,
        )
        Stripe.apiKey = secretKey
        log.info("Stripe inicializado com sucesso")
    }

    @Transactional
    @Throws(StripeException::class)
    fun createCheckoutSession(
            request: PaymentRequestDTO,
            userEmail: String
    ): CheckoutSessionResponse {
        log.info(
                "Iniciando criação de sessão Stripe para planKey: ${request.planKey} para usuário: $userEmail"
        )

        val plan =
                planRepository.findByPlanKeyAndIsActiveTrue(request.planKey).orElseGet {
                    if (request.planKey.startsWith("RECHARGE_")) {
                        try {
                            val amountStr = request.planKey.substring("RECHARGE_".length)
                            val amount = BigDecimal(amountStr)
                            if (amount < MINIMUM_RECHARGE_AMOUNT) {
                                throw IllegalArgumentException(
                                    "Valor mínimo de recarga é R$ $MINIMUM_RECHARGE_AMOUNT. Valor informado: R$ $amount"
                                )
                            }
                            if (amount > BigDecimal.ZERO) {
                                val newPlan = Plan(
                                    planKey = request.planKey,
                                    name = "Recarga R$ $amount",
                                    description = "Recarga de créditos via Stripe",
                                    type = PlanRecurrenceType.ONE_TIME,
                                    priceOneTime = amount,
                                    isActive = true
                                )
                                planRepository.save(newPlan)
                            } else null
                        } catch (e: Exception) {
                            log.error("Erro ao processar plano de recarga dinâmico: ${request.planKey}")
                            null
                        }
                    } else null
                } ?: throw IllegalArgumentException("Plano não encontrado ou inválido: ${request.planKey}")

        // Defesa: FREE não tem checkout. O fluxo correto é /onboarding/submit
        // com planType=FREE, que ativa direto e aloca número compartilhado.
        if (plan.planKey.equals("FREE", ignoreCase = true)) {
            throw IllegalArgumentException(
                "Plano FREE não exige pagamento. Use /onboarding/submit com planType=FREE.",
            )
        }

        val priceId = getOrSyncPriceId(plan, request.billingCycle ?: "MONTHLY")

        val sessionMode =
                if (plan.type == PlanRecurrenceType.RECURRING) SessionCreateParams.Mode.SUBSCRIPTION
                else SessionCreateParams.Mode.PAYMENT

        val isEmbedded = request.uiMode?.equals("embedded", ignoreCase = true) == true

        val finalSuccessUrl =
                "$successUrl?just_paid=true&plan=${plan.planKey.lowercase()}&session_id={CHECKOUT_SESSION_ID}"

        val user =
                userRepository.findByEmail(userEmail)
                        ?: throw IllegalStateException(
                                "Usuário autenticado não encontrado no banco: $userEmail"
                        )

        val stripeCustomerId = user.stripeCustomerId

        val paramsBuilder =
                SessionCreateParams.builder()
                        .setMode(sessionMode)
                        .addLineItem(
                                SessionCreateParams.LineItem.builder()
                                        .setPrice(priceId)
                                        .setQuantity(1L)
                                        .build()
                        )
                        .putMetadata("plan_key", plan.planKey)
                        .putMetadata("billing_cycle", request.billingCycle ?: "ONE_TIME")

        // Recarga junto com subscription é processada via PaymentIntent off-session
        // no webhook (após plano confirmado). O metadata propaga o valor pro handler.
        val rechargeAmountCents = request.rechargeAmountCents ?: 0
        if (sessionMode == SessionCreateParams.Mode.SUBSCRIPTION && rechargeAmountCents > 0) {
            paramsBuilder.putMetadata("recharge_amount_cents", rechargeAmountCents.toString())
        }

        if (isEmbedded) {
            paramsBuilder
                    .setUiMode(SessionCreateParams.UiMode.EMBEDDED)
                    .setReturnUrl(finalSuccessUrl)
        } else {
            paramsBuilder.setSuccessUrl(finalSuccessUrl).setCancelUrl(cancelUrl)
        }

        if (stripeCustomerId != null) {
            paramsBuilder.setCustomer(stripeCustomerId)
        } else {
            paramsBuilder
                    .setBillingAddressCollection(
                            SessionCreateParams.BillingAddressCollection.REQUIRED
                    )
                    .setPhoneNumberCollection(
                            SessionCreateParams.PhoneNumberCollection.builder()
                                    .setEnabled(true)
                                    .build()
                    )
                    .setTaxIdCollection(
                            SessionCreateParams.TaxIdCollection.builder().setEnabled(true).build()
                    )

            if (sessionMode == SessionCreateParams.Mode.PAYMENT) {
                paramsBuilder.setCustomerCreation(SessionCreateParams.CustomerCreation.ALWAYS)
                paramsBuilder.setPaymentIntentData(
                    SessionCreateParams.PaymentIntentData.builder()
                        .setSetupFutureUsage(SessionCreateParams.PaymentIntentData.SetupFutureUsage.OFF_SESSION)
                        .build()
                )
            } else {
                paramsBuilder.setCustomerEmail(userEmail)
            }
        }

        val params = paramsBuilder.build()

        return try {
            val session = Session.create(params)
            if (isEmbedded) {
                CheckoutSessionResponse(clientSecret = session.clientSecret)
            } else {
                CheckoutSessionResponse(url = session.url)
            }
        } catch (e: StripeException) {
            log.error("Erro ao criar sessão no Stripe: ${e.message}")
            throw e
        }
    }

    @Transactional
    fun handleCheckoutSessionCompleted(session: Session) {
        val stripeCustomerId = session.customer
        val userEmail = session.customerEmail ?: session.customerDetails?.email

        val user = if (stripeCustomerId != null) {
            userRepository.findByStripeCustomerId(stripeCustomerId)
                ?: userEmail?.let { userRepository.findByEmail(it) }
        } else {
            userEmail?.let { userRepository.findByEmail(it) }
        } ?: return log.error("Usuário não encontrado para sessão Stripe: ${session.id} (Customer: $stripeCustomerId, Email: $userEmail)")

        // Atualiza ou salva o Customer ID
        if (user.stripeCustomerId == null && stripeCustomerId != null) {
            user.stripeCustomerId = stripeCustomerId
            userRepository.save(user)
        }

        val planKey = session.metadata["plan_key"]
                ?: return log.error("Sessão sem plan_key nos metadados")

        // 1. Processa a assinatura se for recorrente
        if (session.mode == "subscription") {
            val newPlanType = com.arara.api.models.enums.PlanType.valueOf(planKey)
            var subscription = subscriptionRepository.findByUserId(user.id!!)
            if (subscription == null) {
                subscription = AraraSubscription(
                    userId = user.id,
                    planType = newPlanType,
                )
            }
            subscription.stripeSubscriptionId = session.subscription
            subscription.stripePriceId = session.lineItems?.data?.get(0)?.price?.id
            subscriptionLifecycleService.applyPlanChange(
                subscription = subscription,
                newPlan = newPlanType,
                newStatus = SubscriptionStatus.ACTIVE,
                clearDunning = true,
            )
            log.info("Assinatura ativada via Stripe para usuário: ${user.email}, plano: $planKey")

            promoteOrgTrustIfPaidPlan(user.organization.id, newPlanType)

            val planEntity = planRepository.findByPlanKeyAndIsActiveTrue(planKey).orElse(null)
            val planPrice = planEntity?.priceMonthly ?: planEntity?.priceOneTime ?: BigDecimal.ZERO
            if (planPrice > BigDecimal.ZERO) {
                walletService.applyWelcomeBonus(user.organization.id!!, planPrice)
            }
        }

        val amountTotal = session.amountTotal
        if (session.mode == "payment" && amountTotal != null && amountTotal > 0) {
            val amountInReais = BigDecimal(amountTotal).divide(BigDecimal(100))
            walletService.addCredit(
                organizationId = user.organization.id!!,
                amount = amountInReais,
                source = "STRIPE",
                externalId = session.id,
            )
            log.info("Crédito de R$ $amountInReais adicionado via Stripe (mode=payment) para Org ${user.organization.id}")
        }

        // 3. Ativa o usuário e a organização (igual ao AbacatePay)
        activateAccountAndOrganization(user.organization.id!!)

        // 4. Best-effort: dispara notificação interna pra emissão de NF (rebeca@ + slack)
        runCatching {
            val amountReais = amountTotal?.let { BigDecimal(it).divide(BigDecimal(100)) }
                ?: planRepository.findByPlanKeyAndIsActiveTrue(planKey).orElse(null)
                    ?.let { it.priceMonthly ?: it.priceOneTime }
                ?: BigDecimal.ZERO
            val productName = if (session.mode == "subscription") "Assinatura $planKey" else "Recarga $planKey"
            val taxId = session.metadata["tax_id"]
                ?: session.customerDetails?.taxIds?.firstOrNull()?.value
            nfIssuanceNotifier.notifyPurchase(
                organization = user.organization,
                ownerName = user.name,
                ownerEmail = user.email,
                ownerPhone = user.phoneNumber,
                cnpj = taxId,
                amount = amountReais,
                productName = productName,
                source = "STRIPE",
                externalId = session.id,
            )
        }.onFailure {
            log.error("nf.notify.stripe_failed [session={}, err={}]", session.id, it.message, it)
        }
    }

    private fun activateAccountAndOrganization(organizationId: java.util.UUID) {
        val organization = userRepository.findByOrganizationId(organizationId)
            .firstOrNull()?.organization ?: return

        organization.users.forEach { user ->
            val wasAlreadyActive = user.accountStatus == com.arara.api.models.enums.UserStatus.ACTIVE
            if (!wasAlreadyActive) {
                user.accountStatus = com.arara.api.models.enums.UserStatus.ACTIVE
                userRepository.save(user)
                log.info("Usuário ${user.id} ativado via Stripe")
            }
            accountActivationNotifier.notifyActivated(user, wasAlreadyActive)
        }

        // Atribui número compartilhado se necessário
        if (organization.isSharedNumber == true) {
            araraPhoneNumberService.assignSharedNumber(organizationId)
        }
    }

    @Transactional
    fun handleSubscriptionDeleted(stripeSubscriptionId: String) {
        val subscription =
                subscriptionRepository.findByStripeSubscriptionId(stripeSubscriptionId) ?: return
        subscriptionLifecycleService.applyPlanChange(
            subscription = subscription,
            newPlan = com.arara.api.models.enums.PlanType.FREE,
            newStatus = SubscriptionStatus.CANCELLED,
            clearDunning = true,
        )
        val owner = userRepository.findById(subscription.userId).orElse(null)
        if (owner != null) {
            demoteOrgTrustIfNotPaidPlan(owner.organization.id, com.arara.api.models.enums.PlanType.FREE)
        }
        log.info("Assinatura cancelada via Stripe (downgrade FREE): $stripeSubscriptionId")
    }

    @Transactional
    fun handleInvoicePaymentFailed(stripeSubscriptionId: String) {
        val subscription = subscriptionRepository.findByStripeSubscriptionId(stripeSubscriptionId)
        if (subscription == null) {
            log.warn("invoice.payment_failed sem subscription local: $stripeSubscriptionId")
            return
        }
        subscriptionLifecycleService.recordPaymentFailure(subscription)
    }

    @Transactional
    fun handleInvoicePaid(stripeSubscriptionId: String) {
        val subscription = subscriptionRepository.findByStripeSubscriptionId(stripeSubscriptionId)
        if (subscription == null) {
            log.warn("invoice.paid sem subscription local: $stripeSubscriptionId")
            return
        }
        subscriptionLifecycleService.recordPaymentSuccess(subscription)
    }

    fun handlePaymentIntentSucceeded(paymentIntent: com.stripe.model.PaymentIntent) {
        val purpose = paymentIntent.metadata?.get(WalletAutoRechargeService.META_PURPOSE)
        if (purpose != WalletAutoRechargeService.PURPOSE_WALLET_TOPUP) return
        walletAutoRechargeService.handleTopupSucceeded(paymentIntent)
    }

    fun handlePaymentIntentFailed(paymentIntent: com.stripe.model.PaymentIntent) {
        val purpose = paymentIntent.metadata?.get(WalletAutoRechargeService.META_PURPOSE)
        if (purpose != WalletAutoRechargeService.PURPOSE_WALLET_TOPUP) return
        walletAutoRechargeService.handleTopupFailed(paymentIntent)
    }

    @Transactional
    fun handleSubscriptionUpdated(stripeSub: com.stripe.model.Subscription) {
        val subscription = subscriptionRepository.findByStripeSubscriptionId(stripeSub.id)
        if (subscription == null) {
            log.warn("customer.subscription.updated sem subscription local: ${stripeSub.id}")
            return
        }
        val priceId = stripeSub.items?.data?.firstOrNull()?.price?.id
        val plan = priceId?.let { planRepository.findByStripePriceIdMonthly(it).orElse(null) }
            ?: priceId?.let { planRepository.findByStripePriceIdAnnually(it).orElse(null) }

        val newPlanType = plan?.let { runCatching { com.arara.api.models.enums.PlanType.valueOf(it.planKey) }.getOrNull() }
            ?: subscription.planType
        val newStatus = when (stripeSub.status) {
            "active", "trialing" -> SubscriptionStatus.ACTIVE
            "past_due", "unpaid" -> SubscriptionStatus.PENDING_PAYMENT
            "canceled" -> SubscriptionStatus.CANCELLED
            else -> subscription.status
        }
        subscription.stripePriceId = priceId
        subscriptionLifecycleService.applyPlanChange(
            subscription = subscription,
            newPlan = newPlanType,
            newStatus = newStatus,
        )

        if (newStatus == SubscriptionStatus.ACTIVE) {
            val owner = userRepository.findById(subscription.userId).orElse(null)
            if (owner != null) {
                promoteOrgTrustIfPaidPlan(owner.organization.id, newPlanType)
                demoteOrgTrustIfNotPaidPlan(owner.organization.id, newPlanType)
            }
        }
    }

    @Transactional
    @Throws(StripeException::class)
    fun synchronizePlansWithStripe() {
        val plans = planRepository.findAll()
        log.info("Iniciando sincronização de {} planos com a Stripe...", plans.size)

        for (plan in plans) {
            if (plan.planKey.isEmpty()) continue

            val stripeProduct = getOrCreateStripeProduct(plan)
            plan.stripeProductId = stripeProduct.id

            if (plan.type == PlanRecurrenceType.ONE_TIME && plan.priceOneTime != null) {
                plan.stripePriceIdOneTime =
                        getOrCreateStripePrice(
                                        plan,
                                        stripeProduct.id,
                                        plan.priceOneTime!!,
                                        null,
                                        null
                                )
                                .id
            } else if (plan.type == PlanRecurrenceType.RECURRING) {
                if (plan.priceMonthly != null) {
                    plan.stripePriceIdMonthly =
                            getOrCreateStripePrice(
                                            plan,
                                            stripeProduct.id,
                                            plan.priceMonthly!!,
                                            PriceCreateParams.Recurring.Interval.MONTH,
                                            1L
                                    )
                                    .id
                }
                if (plan.priceAnnually != null) {
                    plan.stripePriceIdAnnually =
                            getOrCreateStripePrice(
                                            plan,
                                            stripeProduct.id,
                                            plan.priceAnnually!!,
                                            PriceCreateParams.Recurring.Interval.YEAR,
                                            1L
                                    )
                                    .id
                }
            }
            planRepository.save(plan)
        }
    }

    @Transactional
    @Throws(StripeException::class)
    fun getOrSyncPriceId(plan: Plan, billingCycle: String): String {
        log.info("Verificando IDs da Stripe para o plano: ${plan.planKey} (Cycle: $billingCycle)")
        
        // 1. Garante que o Produto existe na Stripe
        if (plan.stripeProductId == null) {
            val stripeProduct = getOrCreateStripeProduct(plan)
            plan.stripeProductId = stripeProduct.id
            planRepository.save(plan)
        }

        // 2. Garante que o Preço específico existe na Stripe
        val existingPriceId = when {
            plan.type == PlanRecurrenceType.ONE_TIME -> plan.stripePriceIdOneTime
            billingCycle == "ANNUAL" -> plan.stripePriceIdAnnually
            else -> plan.stripePriceIdMonthly
        }

        if (existingPriceId != null) {
            return existingPriceId
        }

        log.info("Preço não encontrado na Stripe para ${plan.planKey}. Criando agora...")

        val newPriceId = when {
            plan.type == PlanRecurrenceType.ONE_TIME -> {
                val amount = plan.priceOneTime ?: throw IllegalStateException("Preço avulso não definido para ${plan.name}")
                getOrCreateStripePrice(plan, plan.stripeProductId!!, amount, null, null).id
            }
            billingCycle == "ANNUAL" -> {
                val amount = plan.priceAnnually ?: throw IllegalStateException("Preço anual não definido para ${plan.name}")
                getOrCreateStripePrice(plan, plan.stripeProductId!!, amount, PriceCreateParams.Recurring.Interval.YEAR, 1L).id
            }
            else -> {
                val amount = plan.priceMonthly ?: throw IllegalStateException("Preço mensal não definido para ${plan.name}")
                getOrCreateStripePrice(plan, plan.stripeProductId!!, amount, PriceCreateParams.Recurring.Interval.MONTH, 1L).id
            }
        }

        // 3. Atualiza o banco de dados com o novo ID
        when {
            plan.type == PlanRecurrenceType.ONE_TIME -> plan.stripePriceIdOneTime = newPriceId
            billingCycle == "ANNUAL" -> plan.stripePriceIdAnnually = newPriceId
            else -> plan.stripePriceIdMonthly = newPriceId
        }
        
        planRepository.save(plan)
        log.info("Novo Price ID gerado e salvo para ${plan.planKey}: $newPriceId")
        
        return newPriceId
    }

    private fun getOrCreateStripeProduct(plan: Plan): Product {
        return plan.stripeProductId?.let { Product.retrieve(it) }
                ?: run {
                    val params =
                            ProductCreateParams.builder()
                                    .setName(plan.name)
                                    .setDescription(plan.description)
                                    .putMetadata("internal_plan_key", plan.planKey)
                                    .build()
                    Product.create(params)
                }
    }

    private fun getOrCreateStripePrice(
            plan: Plan,
            productId: String,
            amount: BigDecimal,
            interval: PriceCreateParams.Recurring.Interval?,
            intervalCount: Long?
    ): Price {
        val priceParams =
                PriceCreateParams.builder()
                        .setProduct(productId)
                        .setUnitAmount(amount.multiply(BigDecimal(100)).toLong())
                        .setCurrency("brl")
                        .putMetadata("internal_plan_key", plan.planKey)

        if (interval != null) {
            priceParams.setRecurring(
                    PriceCreateParams.Recurring.builder()
                            .setInterval(interval)
                            .setIntervalCount(intervalCount)
                            .build()
            )
        }

        return Price.create(priceParams.build())
    }

    class AddonNotConfiguredException(planKey: String) : RuntimeException(
        "Plan row '$planKey' não encontrada. Confirme que V113 rodou em prod ou rode " +
            "INSERT manual seguindo o template da migração.",
    )

    private fun loadAddonPlan(planKey: String): Plan =
        planRepository.findByPlanKeyAndIsActiveTrue(planKey).orElseThrow {
            AddonNotConfiguredException(planKey)
        }

    @Throws(com.stripe.exception.StripeException::class)
    fun createBrainAddonCheckout(
        user: com.arara.api.models.domain.User,
        subscription: com.arara.api.models.domain.Subscription,
    ): String {
        val plan = loadAddonPlan(BRAIN_ADDON_KEY)
        val priceId = getOrSyncPriceId(plan, "MONTHLY")
        val stripeSubId = subscription.stripeSubscriptionId
            ?: throw IllegalStateException(
                "Subscription sem stripeSubscriptionId — cliente precisa estar em plano pago.",
            )

        val params = com.stripe.param.SubscriptionItemCreateParams.builder()
            .setSubscription(stripeSubId)
            .setPrice(priceId)
            .setQuantity(1L)
            .build()
        val item = com.stripe.model.SubscriptionItem.create(params)

        subscriptionLifecycleService.setBrainAddon(subscription, active = true, stripeItemId = item.id)
        log.info(
            "Brain addon subscription item created. [userId={}, subId={}, itemId={}, priceId={}]",
            user.id, subscription.id, item.id, priceId,
        )
        return billingPortalUrl(user)
    }

    @Throws(com.stripe.exception.StripeException::class)
    fun setExtraSeatsQuantity(
        user: com.arara.api.models.domain.User,
        subscription: com.arara.api.models.domain.Subscription,
        count: Int,
    ): String? {
        val plan = loadAddonPlan(EXTRA_SEAT_KEY)
        val priceId = getOrSyncPriceId(plan, "MONTHLY")
        val stripeSubId = subscription.stripeSubscriptionId
            ?: throw IllegalStateException("Subscription sem stripeSubscriptionId.")
        val existingItemId = subscription.extraSeatsStripeItemId

        return when {
            count == 0 && existingItemId != null -> {
                cancelSubscriptionItem(existingItemId)
                log.info("Extra seats item deleted. [subId={}, itemId={}]", subscription.id, existingItemId)
                null
            }
            count == 0 -> null
            existingItemId != null -> {
                val params = com.stripe.param.SubscriptionItemUpdateParams.builder()
                    .setQuantity(count.toLong())
                    .build()
                com.stripe.model.SubscriptionItem.retrieve(existingItemId).update(params)
                log.info(
                    "Extra seats quantity updated. [subId={}, itemId={}, count={}]",
                    subscription.id, existingItemId, count,
                )
                existingItemId
            }
            else -> {
                val params = com.stripe.param.SubscriptionItemCreateParams.builder()
                    .setSubscription(stripeSubId)
                    .setPrice(priceId)
                    .setQuantity(count.toLong())
                    .build()
                val item = com.stripe.model.SubscriptionItem.create(params)
                log.info(
                    "Extra seats item created. [subId={}, itemId={}, count={}, priceId={}]",
                    subscription.id, item.id, count, priceId,
                )
                item.id
            }
        }
    }

    @Throws(com.stripe.exception.StripeException::class)
    fun cancelSubscriptionItem(itemId: String) {
        com.stripe.model.SubscriptionItem.retrieve(itemId).delete()
        log.info("Subscription item deleted. [itemId={}]", itemId)
    }

    private fun promoteOrgTrustIfPaidPlan(organizationId: java.util.UUID?, planType: PlanType) {
        if (organizationId == null || planType !in TRUSTED_PLAN_TYPES) return
        val org = organizationRepository.findById(organizationId).orElse(null)
        if (org == null || org.trustLevel == OrgTrustLevel.TRUSTED) return
        org.trustLevel = OrgTrustLevel.TRUSTED
        organizationRepository.save(org)
        messageQualityGuardService.invalidate(organizationId)
        log.info(
            "Org promoted to TRUSTED via Stripe paid plan. [orgId={}, plan={}]",
            organizationId, planType,
        )
    }

    private fun demoteOrgTrustIfNotPaidPlan(organizationId: java.util.UUID?, planType: PlanType) {
        if (organizationId == null || planType in TRUSTED_PLAN_TYPES) return
        val org = organizationRepository.findById(organizationId).orElse(null)
        if (org == null || org.trustLevel != OrgTrustLevel.TRUSTED) return
        org.trustLevel = OrgTrustLevel.NEW
        organizationRepository.save(org)
        messageQualityGuardService.invalidate(organizationId)
        log.info(
            "Org demoted from TRUSTED to NEW after plan change. [orgId={}, newPlan={}]",
            organizationId, planType,
        )
    }

    private fun billingPortalUrl(user: com.arara.api.models.domain.User): String {
        val customerId = user.stripeCustomerId
            ?: throw IllegalStateException("User sem stripeCustomerId — não tem subscription.")
        val params = com.stripe.param.billingportal.SessionCreateParams.builder()
            .setCustomer(customerId)
            .setReturnUrl("https://ararahq.com/dashboard/faturamento")
            .build()
        return com.stripe.model.billingportal.Session.create(params).url
    }
}
