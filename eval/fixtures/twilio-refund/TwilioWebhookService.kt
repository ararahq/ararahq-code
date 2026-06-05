package com.arara.api.services

import com.arara.api.dto.TwilioStatusCallbackRequest
import com.arara.api.models.domain.Message
import com.arara.api.models.enums.MessageStatus
import com.arara.api.models.repository.MessageRepository
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

@Service
@Suppress("LongParameterList", "TooManyFunctions", "TooGenericExceptionCaught", "SwallowedException")
class TwilioWebhookService(
    private val messageRepository: MessageRepository,
    private val walletService: WalletService,
    private val diagnosticService: MessagingDiagnosticService,
    private val objectMapper: com.fasterxml.jackson.databind.ObjectMapper,
    private val clientWebhookService: ClientWebhookService,
    private val optOutService: OptOutService,
    private val templateRepository: com.arara.api.models.repository.TemplateRepository,
    private val slackNotificationService: SlackNotificationService,
    private val campaignAbMetricsRecorder: CampaignAbMetricsRecorder,
    private val inAppNotificationService: InAppNotificationService,
    private val emailService: EmailService,
    private val organizationContactService: OrganizationContactService,
) {
    private val logger = LoggerFactory.getLogger(TwilioWebhookService::class.java)

    @Transactional
    @Suppress("CyclomaticComplexMethod", "ReturnCount")
    fun processStatusUpdate(request: TwilioStatusCallbackRequest, messageId: java.util.UUID) {
        logger.info("Recebido status da Twilio: MessageId=$messageId, SID=${request.MessageSid ?: "N/A"}, " +
                "Status=${request.MessageStatus ?: "N/A"}, ErrorCode=${request.ErrorCode ?: "N/A"}")

        val message = findMessageOrReturn(messageId) ?: return
        updateProviderSidIfNeeded(message, request.MessageSid)

        val messageStatus = request.MessageStatus
        if (messageStatus.isNullOrBlank()) {
            messageRepository.save(message)
            return
        }

        val newStatus = mapTwilioStatus(messageStatus)
        if (isStatusRegression(message.status, newStatus)) {
            logger.debug(
                "Ignorando regressão de status. " +
                "Status atual: ${message.status}, Novo status: $newStatus para mensagem ${message.id}"
            )
            return
        }

        updateMessageStatus(message, newStatus, request)
        messageRepository.save(message)
        logger.info("Status da mensagem ${message.id} atualizado para $newStatus")

        // 🚀 Notifica o cliente via Webhook Universal
        clientWebhookService.notifyMessageStatusUpdate(message)
    }

    private fun findMessageOrReturn(messageId: java.util.UUID): Message? {
        return messageRepository.findByIdForUpdate(messageId).orElse(null) ?: run {
            logger.warn("Mensagem não encontrada para ID: $messageId")
            null
        }
    }

    private fun updateProviderSidIfNeeded(
        message: Message,
        messageSid: String?
    ) {
        if (message.providerSid == null && !messageSid.isNullOrBlank()) {
            message.providerSid = messageSid
            logger.debug("ProviderSid $messageSid salvo para mensagem ${message.id}")
        }
    }

    private fun updateMessageStatus(
        message: Message,
        newStatus: MessageStatus,
        request: TwilioStatusCallbackRequest
    ) {
        message.status = newStatus
        val now = Instant.now()

        when (newStatus) {
            MessageStatus.DELIVERED -> updateDeliveredStatus(message, now)
            MessageStatus.READ -> updateReadStatus(message, now)
            MessageStatus.FAILED -> updateFailedStatus(message, request)
            else -> {}
        }

        runCatching { campaignAbMetricsRecorder.recordStatus(message, newStatus) }
            .onFailure { logger.warn("A/B metrics record failed [{}]", it.message) }
    }

    private fun updateDeliveredStatus(message: Message, now: Instant) {
        if (message.deliveredAt == null) {
            message.deliveredAt = now
        }
    }

    private fun updateReadStatus(message: Message, now: Instant) {
        if (message.deliveredAt == null) {
            message.deliveredAt = now // Se pulou delivered
        }
        if (message.readAt == null) {
            message.readAt = now
        }
    }

    private fun updateFailedStatus(
        message: Message,
        request: TwilioStatusCallbackRequest
    ) {
        val errorCode = request.ErrorCode ?: "unknown"
        val errorMessage = request.ErrorMessage ?: "No error message provided"
        
        val diagnostic = diagnosticService.getDiagnostic(errorCode)
        val diagnosticJson = try {
            objectMapper.writeValueAsString(diagnostic)
        } catch (e: Exception) {
            "{\"code\":\"ararahq-$errorCode\",\"whatHappened\":\"$errorMessage\",\"howToAct\":\"Procure o suporte.\"}"
        }
        
        message.errorDetails = diagnosticJson

        // Auto opt-out via Twilio error codes
        handleRecipientErrors(message, errorCode)

        // 💸 Estorno Automático se a mensagem foi cobrada (LIVE mode)
        if (message.mode == com.arara.api.models.enums.ApiKeyMode.LIVE && 
            message.cost != null && message.cost!! > java.math.BigDecimal.ZERO && 
            message.user?.id != null) {
            
            try {
                walletService.refund(
                    userId = message.user!!.id!!,
                    amount = message.cost!!,
                    messageId = message.id!!,
                    reason = "Estorno Automático (Webhook): $errorCode - $errorMessage",
                    mode = com.arara.api.models.enums.ApiKeyMode.LIVE
                )
                logger.info("Crédito estornado automaticamente (Webhook) para mensagem ${message.id}")
            } catch (e: Exception) {
                logger.error("Erro ao processar estorno automático para mensagem ${message.id}: ${e.message}")
            }
        }
    }

    private fun mapTwilioStatus(twilioStatus: String): MessageStatus {
        return when (twilioStatus.lowercase()) {
            "queued" -> MessageStatus.PENDING
            "sent" -> MessageStatus.SENT
            "delivered" -> MessageStatus.DELIVERED
            "read" -> MessageStatus.READ
            "failed" -> MessageStatus.FAILED
            "undelivered" -> MessageStatus.FAILED
            else -> {
                logger.warn("Status desconhecido da Twilio: $twilioStatus. Mapeando para SENT.")
                MessageStatus.SENT
            }
        }
    }

    private fun isStatusRegression(current: MessageStatus, new: MessageStatus): Boolean {
        val hierarchy = mapOf(
            MessageStatus.PENDING to STATUS_LEVEL_INITIAL,
            MessageStatus.SCHEDULED to STATUS_LEVEL_INITIAL,
            MessageStatus.PROCESSING to STATUS_LEVEL_PROCESSING,
            MessageStatus.SENT_TO_PROVIDER to STATUS_LEVEL_PROCESSING,
            MessageStatus.SENT to STATUS_LEVEL_SENT,
            MessageStatus.DELIVERED to STATUS_LEVEL_DELIVERED,
            MessageStatus.READ to STATUS_LEVEL_READ,
            MessageStatus.FAILED to STATUS_LEVEL_FAILED,
            MessageStatus.CANCELED to STATUS_LEVEL_FAILED
        )

        val currentLevel = hierarchy[current] ?: STATUS_LEVEL_UNKNOWN
        val newLevel = hierarchy[new] ?: STATUS_LEVEL_UNKNOWN

        return newLevel <= currentLevel && new != MessageStatus.FAILED
    }

    @Suppress("CyclomaticComplexMethod")
    private fun handleRecipientErrors(message: Message, errorCode: String) {
        val receiver = message.receiver
        val organizationId = message.user?.organization?.id ?: return

        when (errorCode) {
            "21610", "63032", "63016" -> {
                logger.warn(
                    "Recipient opt-out/block detected via Twilio error {}. [orgId={}]",
                    errorCode, organizationId
                )
                try {
                    optOutService.markAsOptedOut(organizationId, receiver)
                } catch (exception: Exception) {
                    logger.warn("Failed to auto-mark opt-out: {}", exception.message)
                }
            }
            "63041" -> handleTemplatePaused(message)
            "63042" -> handleTemplateDisabled(message)
            "63040" -> handleTemplateRejected(message)
        }
    }

    private fun handleTemplatePaused(message: Message) {
        val templateName = message.templateName ?: return
        updateTemplateStatus(templateName, "PAUSED")

        slackNotificationService.notifyTemplateAbuse(
            message.user?.organization?.id?.toString(),
            templateName,
            "Template PAUSADO pela Meta (error 63041). " +
                "Feedback negativo dos destinatarios."
        )
    }

    private fun handleTemplateDisabled(message: Message) {
        val templateName = message.templateName ?: return
        updateTemplateStatus(templateName, "DISABLED")

        slackNotificationService.notifyTemplateAbuse(
            message.user?.organization?.id?.toString(),
            templateName,
            "Template DESABILITADO pela Meta (error 63042). " +
                "Violacao de politica ou feedback negativo repetido."
        )
    }

    private fun handleTemplateRejected(message: Message) {
        val templateName = message.templateName ?: return
        updateTemplateStatus(templateName, "REJECTED")

        slackNotificationService.notifyTemplateAbuse(
            message.user?.organization?.id?.toString(),
            templateName,
            "Template REJEITADO pela Meta (error 63040)."
        )
    }

    private fun updateTemplateStatus(templateName: String, newStatus: String) {
        val template = templateRepository.findByProviderTemplateId(templateName)
            ?: templateRepository.findFirstByName(templateName)

        if (template == null) {
            logger.warn(
                "Template '{}' nao encontrado no banco para atualizar status para {}.",
                templateName, newStatus
            )
            return
        }

        val previousStatus = template.providerStatus
        template.providerStatus = newStatus
        templateRepository.save(template)

        logger.warn(
            "Template '{}' (id={}) atualizado para status {}.",
            template.name, template.id, newStatus
        )

        if (previousStatus != newStatus) {
            val notificationType = when (newStatus.uppercase()) {
                "APPROVED" -> com.arara.api.models.enums.InAppNotificationType.TEMPLATE_APPROVED
                "REJECTED" -> com.arara.api.models.enums.InAppNotificationType.TEMPLATE_REJECTED
                else -> null
            }
            if (notificationType != null) {
                val approved = notificationType == com.arara.api.models.enums.InAppNotificationType.TEMPLATE_APPROVED
                val title = if (approved) "Template aprovado pela Meta" else "Template rejeitado pela Meta"
                try {
                    inAppNotificationService.createAlert(
                        organization = template.organization,
                        type = notificationType,
                        title = title,
                        content = AlertContent(
                            body = "${template.name} agora está '$newStatus' na Meta.",
                            link = "/dashboard/templates",
                            payload = mapOf(
                                "templateId" to template.id.toString(),
                                "templateName" to template.name,
                                "rejectionReason" to (template.rejectionReason ?: ""),
                            ),
                        ),
                    )
                } catch (e: Exception) {
                    logger.error("notification.failed [type={}, stage=in_app, templateId={}, err={}]", notificationType, template.id, e.message, e)
                }

                try {
                    val orgId = template.organization.id
                    if (orgId != null) {
                        organizationContactService.resolveAdminEmails(orgId).forEach { email ->
                            if (approved) {
                                emailService.sendTemplateApproved(email, template.name, DASHBOARD_TEMPLATES)
                            } else {
                                emailService.sendTemplateRejected(email, template.name, template.rejectionReason, DASHBOARD_TEMPLATES)
                            }
                        }
                    }
                } catch (e: Exception) {
                    logger.error("notification.failed [type={}, stage=email, templateId={}, err={}]", notificationType, template.id, e.message, e)
                }
            }
        }
    }

    companion object {
        private const val STATUS_LEVEL_UNKNOWN = 0
        private const val STATUS_LEVEL_INITIAL = 1
        private const val STATUS_LEVEL_PROCESSING = 2
        private const val STATUS_LEVEL_SENT = 3
        private const val STATUS_LEVEL_DELIVERED = 4
        private const val STATUS_LEVEL_READ = 5
        private const val STATUS_LEVEL_FAILED = 99
        private const val DASHBOARD_TEMPLATES = "https://ararahq.com/dashboard/templates"
    }
}

