package app.luxora.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MessengerStateTest {
    @Test
    fun sendDraftAddsMessageAndClearsComposer() {
        val state = MessengerState.demo()
        val before = state.selectedMessages.size
        state.draft = "Reliable delivery semantics"

        assertTrue(state.sendDraft())
        assertEquals(before + 1, state.selectedMessages.size)
        assertEquals("Reliable delivery semantics", state.selectedMessages.last().text)
        assertTrue(state.draft.isEmpty())
    }

    @Test
    fun whitespaceIsNotSent() {
        val state = MessengerState.demo()
        val before = state.selectedMessages.size
        state.draft = "  \n "

        assertFalse(state.sendDraft())
        assertEquals(before, state.selectedMessages.size)
    }

    @Test
    fun folderAndSearchCompose() {
        val state = MessengerState.demo()
        state.selectedFolder = "Work"
        state.query = "studio"

        assertEquals(listOf("Luxora Studio"), state.filteredConversations.map { it.title })
    }
}
