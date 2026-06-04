package fixture

// Fixture CONGELADO do bug dos números compartilhados (estado BUGADO, pra o eval ser reproduzível
// independente do código vivo). NÃO é a fonte de produção — é o gabarito do conjunto de avaliação.
// O bug: resolveSender e assignSharedNumber buscam com findFirstByIsActiveTrue() (qualquer número
// ativo, inclusive dedicado de outra org); pickSharedPool já usa a forma correta (pool sem dono).

class AraraPhoneNumberService(
    private val araraPhoneNumberRepository: AraraPhoneNumberRepository,
) {
    fun resolveSender(mode: ApiKeyMode): String {
        if (mode == ApiKeyMode.TEST) {
            val testNumber = araraPhoneNumberRepository.findFirstByIsActiveTrue()
                .orElseThrow { IllegalStateException("Nenhum número da Arara ativo para modo TEST.") }
            return testNumber.phoneNumber
        }
        return "default"
    }

    fun assignSharedNumber(org: Organization): AraraPhoneNumber {
        val araraNumber = araraPhoneNumberRepository.findFirstByIsActiveTrue()
            .orElseThrow { IllegalStateException("No active Arara phone numbers available") }
        araraNumber.organizationId = org.id
        return araraNumber
    }

    fun pickSharedPool(): AraraPhoneNumber {
        val araraShared = araraPhoneNumberRepository.findFirstByOrganizationIdIsNullAndIsActiveTrue()
            .orElseThrow { IllegalStateException("Nenhum número compartilhado disponível.") }
        return araraShared
    }
}
