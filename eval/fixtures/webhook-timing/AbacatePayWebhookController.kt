package com.arara.api.controller

import com.arara.api.dto.AbacatePayWebhookRequest
import com.arara.api.exception.WalletNotFoundException
import com.arara.api.services.AbacatePayWebhookService
import jakarta.validation.Valid
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.math.BigDecimal

@RestController
@RequestMapping("/v1/webhooks/abacatepay")
class AbacatePayWebhookController(
    private val webhookService: AbacatePayWebhookService,
    @Value("\${partners.abacate.webhook-secret:}")
    private val myWebhookSecret: String,
) {
    private val logger = LoggerFactory.getLogger(AbacatePayWebhookController::class.java)

    companion object {
        private const val CENTS_IN_REAL = 100
        private val ACCEPTED_BILLING_STATUSES = setOf("PAID", "COMPLETED", "ACTIVE")
    }

    @PostMapping
    fun handleWebhook(
        @RequestParam(value = "webhookSecret", required = false) receivedSecret: String?,
        @Valid @RequestBody webhookRequest: AbacatePayWebhookRequest,
    ): ResponseEntity<Any> {
        val validationError = validateSecret(receivedSecret)
        if (validationError != null) return validationError

        return try {
            processEvent(webhookRequest)
        } catch (e: IllegalStateException) {
            logger.error("Erro de estado ao processar webhook", e)
            ResponseEntity.internalServerError().body(mapOf("error" to e.message))
        } catch (e: WalletNotFoundException) {
            logger.error("Carteira não encontrada ao processar webhook", e)
            ResponseEntity.internalServerError().body(mapOf("error" to "Carteira não encontrada"))
        } catch (e: IllegalArgumentException) {
            logger.error("Dados inválidos no webhook", e)
            ResponseEntity.badRequest().body(mapOf("error" to e.message))
        }
    }

    private fun validateSecret(receivedSecret: String?): ResponseEntity<Any>? {
        return when {
            myWebhookSecret.isBlank() -> ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(mapOf("error" to "Webhook secret not configured"))
            receivedSecret == null || receivedSecret.isBlank() -> ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(mapOf("error" to "Webhook secret not provided"))
            receivedSecret != myWebhookSecret -> ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(mapOf("error" to "Invalid webhook secret"))
            else -> null
        }
    }

    private fun processEvent(webhookRequest: AbacatePayWebhookRequest): ResponseEntity<Any> {
        return when (webhookRequest.event) {
            "billing.paid" -> processBillingPaid(webhookRequest)
            "pix.paid" -> processPixPaid(webhookRequest)
            else -> {
                logger.info("Evento ignorado: ${webhookRequest.event}")
                ResponseEntity.ok(mapOf("status" to "ignored", "event" to webhookRequest.event))
            }
        }
    }

    private fun processBillingPaid(request: AbacatePayWebhookRequest): ResponseEntity<Any> {
        val billing = request.data.billing
        val pix = request.data.pixQrCode

        val id = billing?.id ?: pix?.id
            ?: return ResponseEntity.badRequest().body(mapOf("error" to "Billing/PIX ID missing"))
        val amount = billing?.amount ?: pix?.amount
            ?: return ResponseEntity.badRequest().body(mapOf("error" to "Amount missing"))
        val status = billing?.status ?: pix?.status ?: "PAID"

        return if (status !in ACCEPTED_BILLING_STATUSES) {
            ResponseEntity.ok(
                mapOf("status" to "ignored", "reason" to "Status not PAID/COMPLETED/ACTIVE (found: $status)"),
            )
        } else {
            val amountInReais = BigDecimal(amount).divide(BigDecimal(CENTS_IN_REAL))
            webhookService.processCredit(
                amountInReais = amountInReais,
                externalId = id,
                customer = billing?.customer,
            )
        }
    }

    private fun processPixPaid(request: AbacatePayWebhookRequest): ResponseEntity<Any> {
        val data = request.data
        val pix = data.pixQrCode

        val id = pix?.id ?: data.id
            ?: return ResponseEntity.badRequest().body(mapOf("error" to "Pix ID missing"))
        val amount = pix?.amount ?: data.amount
            ?: return ResponseEntity.badRequest().body(mapOf("error" to "Pix amount missing"))
        val status = pix?.status ?: data.status ?: "PAID"

        return if (status != "PAID") {
            ResponseEntity.ok(mapOf("status" to "ignored", "reason" to "Status not PAID"))
        } else {
            val amountInReais = BigDecimal(amount).divide(BigDecimal(CENTS_IN_REAL))
            webhookService.processCredit(
                amountInReais = amountInReais,
                externalId = id,
                customer = null,
            )
        }
    }
}
