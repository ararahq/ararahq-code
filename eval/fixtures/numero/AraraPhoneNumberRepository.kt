package fixture

import java.util.Optional

// Interface do repositório (Spring Data). Declara as DUAS queries: a abrangente (bug) e a do pool
// sem dono (correta). A existência das duas é o que torna a divergência detectável pela comparação pareada.
interface AraraPhoneNumberRepository {
    fun findFirstByIsActiveTrue(): Optional<AraraPhoneNumber>
    fun findFirstByOrganizationIdIsNullAndIsActiveTrue(): Optional<AraraPhoneNumber>
}
