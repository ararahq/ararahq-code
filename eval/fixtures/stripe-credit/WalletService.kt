package com.arara.api.services

import com.arara.api.exception.InsufficientFundsException
import com.arara.api.exception.WalletNotFoundException
import com.arara.api.models.domain.Organization
import com.arara.api.models.domain.Wallet
import com.arara.api.models.domain.WalletTransaction
import com.arara.api.models.enums.ApiKeyMode
import com.arara.api.models.enums.TransactionType
import com.arara.api.models.repository.OrganizationRepository
import com.arara.api.models.repository.UserRepository
import com.arara.api.models.repository.WalletRepository
import com.arara.api.models.repository.WalletTransactionRepository
import org.slf4j.LoggerFactory
import org.springframework.context.ApplicationEventPublisher
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.util.UUID

@Service
@Suppress("LongParameterList")
class WalletService(
    private val walletRepository: WalletRepository,
    private val transactionRepository: WalletTransactionRepository,
    private val organizationRepository: OrganizationRepository,
    private val userRepository: UserRepository,
    private val inAppNotificationService: InAppNotificationService,
    private val eventPublisher: ApplicationEventPublisher,
    private val emailService: EmailService,
    private val organizationContactService: OrganizationContactService,
) {
    private val log = LoggerFactory.getLogger(WalletService::class.java)

    /**
     * Debita créditos da carteira do usuário.
     * Usa lock pessimista para evitar condições de corrida.
     * Internamente obtém a organização do usuário.
     * 
     * @param userId ID do usuário
     * @param cost Valor a ser debitado
     * @param messageId ID da mensagem (para referência)
     * @param reason Descrição da transação
     * @throws WalletNotFoundException Se a carteira não existir
     * @throws InsufficientFundsException Se o saldo for insuficiente
     */
    @Transactional
    fun deductCredit(
        userId: UUID,
        cost: BigDecimal,
        messageId: UUID,
        reason: String,
        mode: ApiKeyMode = ApiKeyMode.LIVE
    ) {
        val user = userRepository.findById(userId)
            .orElseThrow { IllegalStateException("Usuário não encontrado: $userId") }
        
        val organizationId = user.organization.id!!
        deductCreditByOrganization(organizationId, cost, messageId, reason, mode)
    }

    /**
     * Debita créditos da carteira da organização.
     * Usa lock pessimista para evitar condições de corrida.
     * 
     * @param organizationId ID da organização
     * @param cost Valor a ser debitado
     * @param messageId ID da mensagem (para referência)
     * @param reason Descrição da transação
     * @throws WalletNotFoundException Se a carteira não existir
     * @throws InsufficientFundsException Se o saldo for insuficiente
     */
    @Transactional
    fun deductCreditByOrganization(
        organizationId: UUID,
        cost: BigDecimal,
        messageId: UUID,
        reason: String,
        mode: ApiKeyMode = ApiKeyMode.LIVE
    ) {
        val wallet = walletRepository.findByOrganizationIdLocking(organizationId)
            ?: throw WalletNotFoundException("Carteira não encontrada para organização $organizationId")

        val currentBalance = if (mode == ApiKeyMode.LIVE) wallet.balance else wallet.testBalance

        if (currentBalance < cost) {
            val balanceType = if (mode == ApiKeyMode.LIVE) "Real" else "Teste"
            throw InsufficientFundsException(
                "Saldo $balanceType insuficiente. Saldo atual: R$ $currentBalance, " +
                "Valor necessário: R$ $cost"
            )
        }

        if (mode == ApiKeyMode.LIVE) {
            wallet.balance = wallet.balance.subtract(cost)
        } else {
            wallet.testBalance = wallet.testBalance.subtract(cost)
        }
        
        walletRepository.save(wallet)

        val transaction = WalletTransaction(
            walletId = wallet.id!!,
            amount = cost.negate(),
            type = TransactionType.CHARGE,
            referenceId = messageId.toString(),
            description = reason,
            mode = mode
        )
        transactionRepository.save(transaction)

        val newBalance = if (mode == ApiKeyMode.LIVE) wallet.balance else wallet.testBalance
        log.info(
            "Crédito debitado ($mode): Organização $organizationId, Valor: R$ $cost, " +
            "Saldo restante: R$ $newBalance, Mensagem: $messageId"
        )

        if (mode == ApiKeyMode.LIVE && currentBalance >= BALANCE_LOW_THRESHOLD && newBalance < BALANCE_LOW_THRESHOLD) {
            dispatchBalanceLowAlert(organizationId, newBalance)
        }

        if (mode == ApiKeyMode.LIVE && wallet.autoRechargeEnabled && newBalance <= wallet.autoRechargeThreshold) {
            eventPublisher.publishEvent(WalletBalanceLowEvent(organizationId, newBalance))
        }
    }

    /**
     * Estorna créditos para a carteira do usuário.
     * Usado quando uma mensagem falha no envio.
     * Internamente obtém a organização do usuário.
     * 
     * @param userId ID do usuário
     * @param amount Valor a ser estornado
     * @param messageId ID da mensagem (para referência)
     * @param reason Descrição do estorno
     */
    @Transactional
    fun refund(
        userId: UUID,
        amount: BigDecimal,
        messageId: UUID,
        reason: String,
        mode: ApiKeyMode = ApiKeyMode.LIVE
    ) {
        val user = userRepository.findById(userId)
            .orElseThrow { IllegalStateException("Usuário não encontrado: $userId") }
        
        val organizationId = user.organization.id!!
        val wallet = walletRepository.findByOrganizationIdLocking(organizationId)
            ?: throw WalletNotFoundException("Carteira não encontrada para organização $organizationId")

        if (mode == ApiKeyMode.LIVE) {
            wallet.balance = wallet.balance.add(amount)
        } else {
            wallet.testBalance = wallet.testBalance.add(amount)
        }
        
        walletRepository.save(wallet)

        val transaction = WalletTransaction(
            walletId = wallet.id!!,
            amount = amount,
            type = TransactionType.REFUND,
            referenceId = messageId.toString(),
            description = reason,
            mode = mode
        )
        transactionRepository.save(transaction)

        val newBalance = if (mode == ApiKeyMode.LIVE) wallet.balance else wallet.testBalance
        log.info(
            "Crédito estornado ($mode): Organização $organizationId, Valor: R$ $amount, " +
            "Novo saldo: R$ $newBalance, Mensagem: $messageId"
        )
    }

    /**
     * Retorna o saldo atual da carteira do usuário.
     */
    fun getBalanceForUser(userId: UUID, mode: ApiKeyMode = ApiKeyMode.LIVE): BigDecimal {
        val user = userRepository.findById(userId).orElse(null) ?: return BigDecimal.ZERO
        val organizationId = user.organization.id
        return if (organizationId != null) getBalance(organizationId, mode) else BigDecimal.ZERO
    }

    /**
     * Retorna o saldo atual da carteira da organização.
     */
    fun getBalance(organizationId: UUID, mode: ApiKeyMode = ApiKeyMode.LIVE): BigDecimal {
        val wallet = walletRepository.findByOrganizationId(organizationId)
            ?: return if (mode == ApiKeyMode.LIVE) BigDecimal.ZERO else BigDecimal("1000.0000")
        return if (mode == ApiKeyMode.LIVE) wallet.balance else wallet.testBalance
    }

    /**
     * Reseta o saldo de teste para o valor padrão (R$ 1000,00).
     */
    @Transactional
    fun resetTestBalance(userId: UUID) {
        val user = userRepository.findById(userId)
            .orElseThrow { IllegalStateException("Usuário não encontrado: $userId") }
        
        val organizationId = user.organization.id!!
        val wallet = walletRepository.findByOrganizationIdLocking(organizationId)
            ?: throw WalletNotFoundException("Carteira não encontrada para organização $organizationId")

        wallet.testBalance = BigDecimal("1000.0000")
        walletRepository.save(wallet)

        val transaction = WalletTransaction(
            walletId = wallet.id!!,
            amount = BigDecimal("1000.0000"),
            type = TransactionType.TOPUP,
            referenceId = "RESET-${UUID.randomUUID()}",
            description = "Reset de saldo de teste",
            mode = ApiKeyMode.TEST
        )
        transactionRepository.save(transaction)

        log.info("Saldo de teste resetado para Organização $organizationId por usuário $userId")
    }

    /**
     * Cria uma nova carteira para uma organização se não existir.
     */
    @Transactional
    fun createWallet(organization: Organization): Wallet {
        val existing = walletRepository.findByOrganizationId(organization.id!!)
        if (existing != null) return existing

        val newWallet = Wallet(
            organization = organization,
            balance = BigDecimal.ZERO,
            currency = "BRL",
            version = 0
        )
        val savedWallet = walletRepository.save(newWallet)
        log.info("Carteira criada para organização ${organization.id} (ID: ${savedWallet.id})")
        return savedWallet
    }

    /**
     * Adiciona créditos à carteira da organização.
     * Usado pelo endpoint administrativo e webhooks de pagamento.
     *
     * Se a carteira não existir, ela será criada automaticamente.
     *
     * @param organizationId ID da organização
     * @param amount Valor a ser adicionado
     * @param source Origem do crédito (ex: "ADMIN_API", "ABACATEPAY", "STRIPE")
     * @param externalId ID externo do pagamento (opcional)
     */
    @Transactional
    fun addCredit(
        organizationId: UUID,
        amount: BigDecimal,
        source: String,
        externalId: String?
    ) {
        val existingWallet = walletRepository.findByOrganizationId(organizationId)

        val lockedWallet = if (existingWallet == null) {
            val organization = organizationRepository.findById(organizationId)
                .orElseThrow { IllegalStateException("Organização não encontrada: $organizationId") }

            createWallet(organization)

            walletRepository.findByOrganizationIdLocking(organizationId)
                ?: throw WalletNotFoundException("Erro ao recuperar carteira bloqueada após criação")
        } else {
            walletRepository.findByOrganizationIdLocking(organizationId)
                ?: throw WalletNotFoundException("Carteira não encontrada para organização $organizationId")
        }

        lockedWallet.balance = lockedWallet.balance.add(amount)
        walletRepository.save(lockedWallet)

        val transaction = WalletTransaction(
            walletId = lockedWallet.id!!,
            amount = amount,
            type = TransactionType.TOPUP,
            referenceId = externalId ?: "MANUAL-${UUID.randomUUID()}",
            description = "Recarga via $source",
            createdAt = Instant.now()
        )

        transactionRepository.save(transaction)

        log.info(
            "Crédito adicionado: Organização $organizationId, Valor: R$ $amount, " +
            "Novo saldo: R$ ${lockedWallet.balance}, Fonte: $source"
        )

        dispatchBalanceToppedUp(organizationId, amount, lockedWallet.balance)
    }

    private fun dispatchBalanceLowAlert(organizationId: UUID, newBalance: BigDecimal) {
        val org = try {
            organizationRepository.findById(organizationId).orElse(null)
        } catch (e: Exception) {
            log.error("notification.failed [type=BALANCE_LOW, stage=org_lookup, orgId={}, err={}]", organizationId, e.message, e)
            return
        } ?: return

        try {
            inAppNotificationService.createAlert(
                organization = org,
                type = com.arara.api.models.enums.InAppNotificationType.BALANCE_LOW,
                title = "Saldo baixo",
                content = AlertContent(
                    body = "Saldo caiu pra R\$ $newBalance. Recarregue pra não pausar envios.",
                    link = "/dashboard/faturamento",
                    payload = mapOf("balance" to newBalance, "threshold" to BALANCE_LOW_THRESHOLD),
                ),
            )
        } catch (e: Exception) {
            log.error("notification.failed [type=BALANCE_LOW, stage=in_app, orgId={}, err={}]", organizationId, e.message, e)
        }

        try {
            organizationContactService.resolveAdminEmails(organizationId).forEach { email ->
                emailService.sendBalanceLow(
                    to = email,
                    organizationName = org.name,
                    balance = newBalance.toPlainString(),
                    dashboardLink = DASHBOARD_FATURAMENTO,
                )
            }
        } catch (e: Exception) {
            log.error("notification.failed [type=BALANCE_LOW, stage=email, orgId={}, err={}]", organizationId, e.message, e)
        }
    }

    @Suppress("TooGenericExceptionCaught")
    private fun dispatchBalanceToppedUp(organizationId: UUID, amount: BigDecimal, newBalance: BigDecimal) {
        val org = try {
            organizationRepository.findById(organizationId).orElse(null)
        } catch (e: Exception) {
            log.error(
                "notification.failed [type=BALANCE_TOPPED_UP, stage=org_lookup, orgId={}, err={}]",
                organizationId, e.message, e,
            )
            return
        } ?: return

        try {
            inAppNotificationService.createAlert(
                organization = org,
                type = com.arara.api.models.enums.InAppNotificationType.BALANCE_TOPPED_UP,
                title = "Recarga confirmada",
                content = AlertContent(
                    body = "Saldo subiu pra R$ ${newBalance.toPlainString()}. Pronto pra enviar.",
                    link = "/dashboard/faturamento",
                    payload = mapOf("amount" to amount, "newBalance" to newBalance),
                ),
            )
        } catch (e: Exception) {
            log.error(
                "notification.failed [type=BALANCE_TOPPED_UP, stage=in_app, orgId={}, err={}]",
                organizationId, e.message, e,
            )
        }

        try {
            organizationContactService.resolveAdminEmails(organizationId).forEach { email ->
                emailService.sendRechargeConfirmed(
                    to = email,
                    organizationName = org.name,
                    amount = "R$ ${amount.toPlainString()}",
                    newBalance = "R$ ${newBalance.toPlainString()}",
                    dashboardLink = DASHBOARD_FATURAMENTO,
                )
            }
        } catch (e: Exception) {
            log.error(
                "notification.failed [type=BALANCE_TOPPED_UP, stage=email, orgId={}, err={}]",
                organizationId, e.message, e,
            )
        }
    }

    @Suppress("TooGenericExceptionCaught")
    private fun dispatchWelcomeBonusCredited(organizationId: UUID, bonus: BigDecimal) {
        val org = try {
            organizationRepository.findById(organizationId).orElse(null)
        } catch (e: Exception) {
            log.error(
                "notification.failed [type=WELCOME_BONUS_CREDITED, stage=org_lookup, orgId={}, err={}]",
                organizationId, e.message, e,
            )
            return
        } ?: return

        val bonusDisplay = "R$ ${bonus.toPlainString()}"
        try {
            inAppNotificationService.createAlert(
                organization = org,
                type = com.arara.api.models.enums.InAppNotificationType.WELCOME_BONUS_CREDITED,
                title = "Você ganhou $bonusDisplay de bônus",
                content = AlertContent(
                    body = "Bônus creditado no saldo. Aproveita pra mandar a primeira mensagem agora.",
                    link = DASHBOARD_PRIMEIRO_ENVIO,
                    payload = mapOf("bonus" to bonus),
                ),
            )
        } catch (e: Exception) {
            log.error(
                "notification.failed [type=WELCOME_BONUS_CREDITED, stage=in_app, orgId={}, err={}]",
                organizationId, e.message, e,
            )
        }

        try {
            organizationContactService.resolveAdminEmails(organizationId).forEach { email ->
                emailService.sendWelcomeBonus(
                    to = email,
                    organizationName = org.name,
                    bonusAmount = bonusDisplay,
                    firstMessageLink = DASHBOARD_PRIMEIRO_ENVIO,
                )
            }
        } catch (e: Exception) {
            log.error(
                "notification.failed [type=WELCOME_BONUS_CREDITED, stage=email, orgId={}, err={}]",
                organizationId, e.message, e,
            )
        }
    }

    @Transactional
    fun applyWelcomeBonus(organizationId: UUID, planPriceReais: BigDecimal) {
        if (planPriceReais <= BigDecimal.ZERO) return
        try {
            val wallet = walletRepository.findByOrganizationIdLocking(organizationId)
                ?: run {
                    val org = organizationRepository.findById(organizationId)
                        .orElseThrow { IllegalStateException("Organização não encontrada: $organizationId") }
                    createWallet(org)
                    walletRepository.findByOrganizationIdLocking(organizationId)
                        ?: throw WalletNotFoundException("Erro ao criar carteira pra welcome bonus")
                }

            val existingBonusCount = transactionRepository.countByWalletIdAndType(wallet.id!!, TransactionType.BONUS)
            if (existingBonusCount > 0L) {
                log.info("Welcome bonus skipped: org already has BONUS transaction. [orgId={}]", organizationId)
                return
            }

            val bonus = planPriceReais.multiply(BONUS_RATE).setScale(BONUS_SCALE, RoundingMode.HALF_UP)
            if (bonus <= BigDecimal.ZERO) return

            wallet.balance = wallet.balance.add(bonus)
            walletRepository.save(wallet)
            transactionRepository.save(
                WalletTransaction(
                    walletId = wallet.id!!,
                    amount = bonus,
                    type = TransactionType.BONUS,
                    referenceId = "WELCOME-BONUS-${UUID.randomUUID()}",
                    description = WELCOME_BONUS_DESCRIPTION,
                    createdAt = Instant.now(),
                )
            )
            log.info(
                "Welcome bonus applied. [orgId={}, planPrice={}, bonus={}, newBalance={}]",
                organizationId, planPriceReais, bonus, wallet.balance,
            )
            dispatchWelcomeBonusCredited(organizationId, bonus)
        } catch (e: Exception) {
            log.error("Welcome bonus failed (plan already active). [orgId={}, err={}]", organizationId, e.message, e)
        }
    }

    companion object {
        private val BALANCE_LOW_THRESHOLD = BigDecimal("50.00")
        private const val DASHBOARD_FATURAMENTO = "https://ararahq.com/dashboard/faturamento"
        private const val DASHBOARD_PRIMEIRO_ENVIO = "https://ararahq.com/dashboard/nova-mensagem"
        private val BONUS_RATE = BigDecimal("0.30")
        private const val BONUS_SCALE = 4
        private const val WELCOME_BONUS_DESCRIPTION = "Bônus de boas-vindas (30% do plano)"
    }
}

