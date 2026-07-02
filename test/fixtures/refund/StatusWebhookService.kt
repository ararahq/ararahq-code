package fixture

// Synthetic fixture: a webhook handler that calls LedgerService. Neutral domain, no product code.

class StatusWebhookService(
    private val ledgerService: LedgerService,
    private val messageRepository: MessageRepository,
) {
    fun processStatusUpdate(event: StatusEvent) {
        val message = messageRepository.findById(event.messageId) ?: return
        if (event.status == "FAILED") {
            try {
                ledgerService.refund(message.accountId, message.cost)
            } catch (e: Exception) {
                // swallowed: the refund can silently vanish here (lost-msg mechanism for the smell test)
            }
        }
    }
}
