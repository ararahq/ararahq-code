package com.arara.api.controller

import com.arara.api.services.onboarding.WhatsAppOnboardingOrchestrator
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import java.util.Base64

/**
 * Recebe webhooks da Salvy (Svix). Hoje só processa o evento `sms.received`.
 *
 * Validação de assinatura: Svix manda 3 headers — svix-id, svix-timestamp,
 * svix-signature. A assinatura é `v1,<base64(hmac-sha256(secret, "id.ts.body"))>`.
 * Spec: https://docs.svix.com/receiving/verifying-payloads/how-manual
 *
 * Anti-replay: rejeita timestamp > 5min de skew.
 *
 * Payload do evento (inferido — doc Salvy não publica schema, então parseamos
 * tolerantemente). Esperamos algo tipo:
 *   { "type": "sms.received", "timestamp": "...",
 *     "data": { "phoneNumber": "+551130001234", "from": "...", "body": "..." } }
 */
@RestController
@RequestMapping("/webhooks/salvy")
class SalvyWebhookController(
    private val orchestrator: WhatsAppOnboardingOrchestrator,
    private val objectMapper: ObjectMapper,
    @Value("\${salvy.webhook-secret:}") private val webhookSecret: String,
) {
    private val log = LoggerFactory.getLogger(SalvyWebhookController::class.java)

    @PostMapping("/sms")
    fun sms(
        @RequestHeader(value = "svix-id", required = false) svixId: String?,
        @RequestHeader(value = "svix-timestamp", required = false) svixTs: String?,
        @RequestHeader(value = "svix-signature", required = false) svixSig: String?,
        @RequestBody rawBody: String,
    ): ResponseEntity<Map<String, String>> {
        if (!verifySignature(svixId, svixTs, svixSig, rawBody)) {
            log.warn("salvy.webhook.invalid_signature [id={}]", svixId)
            return ResponseEntity.status(401).body(mapOf("error" to "invalid_signature"))
        }

        val root = runCatching { objectMapper.readTree(rawBody) }.getOrElse {
            log.warn("salvy.webhook.invalid_json [err={}]", it.message)
            return ResponseEntity.badRequest().body(mapOf("error" to "invalid_json"))
        }

        val type = root.path("type").asText("")
        if (type != "sms.received") {
            log.info("salvy.webhook.ignored_event [type={}]", type)
            return ResponseEntity.ok(mapOf("status" to "ignored"))
        }

        val data: JsonNode = root.path("data")
        val toNumber = data.path("destinationPhoneNumber").asText().ifBlank {
            data.path("phoneNumber").asText()
        }
        val body = data.path("message").asText().ifBlank {
            data.path("body").asText()
        }

        // Salvy já extrai códigos conhecidos (WhatsApp/Meta) em data.detections.whatsapp.verificationCode.
        // Quando vier, usamos direto — pula a regex.
        val preExtractedCode = data.path("detections").path("whatsapp").path("verificationCode")
            .takeIf { it.isTextual }?.asText()?.takeIf { it.isNotBlank() }

        if (toNumber.isBlank() || (body.isBlank() && preExtractedCode == null)) {
            log.warn(
                "salvy.webhook.missing_fields [to={}, hasBody={}, fullPayload={}]",
                toNumber, body.isNotBlank(), rawBody.take(2000),
            )
            return ResponseEntity.ok(mapOf("status" to "missing_fields"))
        }

        orchestrator.handleSmsReceived(toNumber, body, preExtractedCode)
        return ResponseEntity.ok(mapOf("status" to "processed"))
    }

    /**
     * Validação Svix: signed_payload = "{svix-id}.{svix-timestamp}.{body}".
     * Header pode conter múltiplas assinaturas separadas por espaço, formato
     * "v1,<b64>". Aceitamos qualquer que casar.
     */
    private fun verifySignature(
        svixId: String?,
        svixTs: String?,
        svixSig: String?,
        body: String,
    ): Boolean {
        if (webhookSecret.isBlank()) {
            // Sem secret configurado → modo permissivo (dev/staging sem webhook real).
            // Em prod, log forte pra ninguém esquecer.
            log.warn("salvy.webhook.no_secret_configured [accepting_anyway=true]")
            return true
        }
        if (svixId.isNullOrBlank() || svixTs.isNullOrBlank() || svixSig.isNullOrBlank()) {
            return false
        }
        // Anti-replay: 5min de tolerância
        val ts = svixTs.toLongOrNull() ?: return false
        val nowSec = System.currentTimeMillis() / 1000
        if (kotlin.math.abs(nowSec - ts) > MAX_SKEW_SECONDS) {
            log.warn("salvy.webhook.timestamp_skew [ts={}, now={}]", ts, nowSec)
            return false
        }

        val signedPayload = "$svixId.$svixTs.$body"
        // Salvy/Svix usa secret no formato "whsec_..." — extraímos a parte b64.
        val keyB64 = webhookSecret.removePrefix("whsec_")
        val keyBytes = runCatching { Base64.getDecoder().decode(keyB64) }
            .getOrElse {
                log.warn("salvy.webhook.invalid_secret_format")
                return false
            }
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(keyBytes, "HmacSHA256"))
        val expected = Base64.getEncoder().encodeToString(mac.doFinal(signedPayload.toByteArray()))

        // Header pode ter "v1,<sig> v1,<sig2>"
        val signatures = svixSig.split(" ").mapNotNull {
            val parts = it.split(",")
            if (parts.size == 2 && parts[0] == "v1") parts[1] else null
        }
        return signatures.any { constantTimeEquals(it, expected) }
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
        return diff == 0
    }

    private companion object {
        const val MAX_SKEW_SECONDS = 300L
    }
}
