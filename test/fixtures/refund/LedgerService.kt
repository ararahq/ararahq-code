package fixture

// Synthetic fixture for navigation/locator tests. Neutral domain, no product code.
// A small service called by a webhook handler — exercises the call-graph and ranking.

class LedgerService(
    private val ledgerRepository: LedgerRepository,
) {
    fun refund(accountId: String, amount: Long): Boolean {
        val entry = ledgerRepository.findByAccountId(accountId) ?: return false
        entry.balance += amount
        ledgerRepository.save(entry)
        return true
    }

    fun credit(accountId: String, amount: Long) {
        val entry = ledgerRepository.findByAccountId(accountId) ?: return
        entry.balance += amount
        ledgerRepository.save(entry)
    }
}
