package com.arara.api.controller

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/webhooks/meta")
class MetaWebhookController {

    @Value("\${meta.webhook.verify-token}")
    private lateinit var verifyToken: String

    private val logger = LoggerFactory.getLogger(MetaWebhookController::class.java)

    @GetMapping
    fun verifyWebhook(
        @RequestParam("hub.mode") mode: String?,
        @RequestParam("hub.verify_token") token: String?,
        @RequestParam("hub.challenge") challenge: String?
    ): ResponseEntity<String> {

        if (mode == "subscribe" && token == verifyToken) {
            return ResponseEntity.ok(challenge)
        }

        return ResponseEntity.status(HttpStatus.FORBIDDEN).build()
    }

    @PostMapping
    fun receiveEvent(@RequestBody payload: String): ResponseEntity<Void> {
        logger.info("Evento Meta Recebido: $payload")

        return ResponseEntity.ok().build()
    }
}
