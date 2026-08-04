package app.luxora.android.data

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.luxora.android.model.Conversation
import app.luxora.android.model.ConversationKind
import app.luxora.android.model.Delivery
import app.luxora.android.model.Message
import app.luxora.android.model.Participant
import app.luxora.android.model.Reaction
import java.time.Instant

class MessengerState private constructor(
    conversations: List<Conversation>,
    initialMessages: Map<String, List<Message>>,
    val me: Participant,
) {
    val conversations = mutableStateListOf<Conversation>().apply { addAll(conversations) }
    private val messagesByConversation = mutableStateMapOf<String, List<Message>>().apply {
        putAll(initialMessages)
    }

    var selectedConversationId by mutableStateOf(conversations.firstOrNull()?.id)
    var selectedFolder by mutableStateOf("All")
    var query by mutableStateOf("")
    var draft by mutableStateOf("")

    val selectedConversation: Conversation?
        get() = conversations.firstOrNull { it.id == selectedConversationId }

    val selectedMessages: List<Message>
        get() = messagesByConversation[selectedConversationId].orEmpty()

    val filteredConversations: List<Conversation>
        get() = conversations
            .asSequence()
            .filter {
                when (selectedFolder) {
                    "Unread" -> it.unread > 0
                    "Personal" -> it.folder == "personal"
                    "Work" -> it.folder == "work"
                    else -> true
                }
            }
            .filter {
                query.isBlank() ||
                    it.title.contains(query, ignoreCase = true) ||
                    it.preview.contains(query, ignoreCase = true)
            }
            .sortedWith(compareByDescending<Conversation> { it.pinned }.thenByDescending { it.updatedAt })
            .toList()

    fun select(id: String) {
        selectedConversationId = id
        conversations.indexOfFirst { it.id == id }
            .takeIf { it >= 0 }
            ?.let { index -> conversations[index] = conversations[index].copy(unread = 0) }
    }

    fun sendDraft(): Boolean {
        val conversationId = selectedConversationId ?: return false
        val body = draft.trim()
        if (body.isEmpty()) return false

        val message = Message(
            conversationId = conversationId,
            author = me,
            text = body,
            sentAt = Instant.now(),
            delivery = Delivery.Sent,
            outgoing = true,
        )
        messagesByConversation[conversationId] = selectedMessages + message
        val index = conversations.indexOfFirst { it.id == conversationId }
        if (index >= 0) {
            conversations[index] = conversations[index].copy(preview = body, updatedAt = Instant.now())
        }
        draft = ""
        return true
    }

    companion object {
        fun demo(): MessengerState {
            val me = Participant("me", "Alex Morgan", "alex", "AM", 0xFF7C48D4, true, "Building something luminous")
            val mira = Participant("mira", "Mira Chen", "mira", "MC", 0xFF373ABF, true, "Designing calm software")
            val studio = Participant("studio", "Luxora Studio", "luxora", "LS", 0xFF5C3FB7, true, "18 members online")
            val dispatch = Participant("dispatch", "Design Dispatch", "design-dispatch", "DD", 0xFF181FB2, false, "Channel")
            val now = Instant.now()
            val conversations = listOf(
                Conversation("mira-chat", mira.name, "The motion feels natural now ✦", ConversationKind.Direct, mira, "personal", 2, 2, true, false, true, now.minusSeconds(45)),
                Conversation("studio-chat", studio.name, "Noah: API contract is ready for review", ConversationKind.Group, studio, "work", 42, 7, true, false, false, now.minusSeconds(240)),
                Conversation("dispatch-chat", dispatch.name, "A field guide to humane notifications", ConversationKind.Channel, dispatch, "work", 18_420, 0, false, true, false, now.minusSeconds(3_600)),
                Conversation("saved", "Saved", "Flight details and launch notes", ConversationKind.Saved, me, "personal", 1, 0, false, false, false, now.minusSeconds(8_000)),
            )
            val messages = mapOf(
                "mira-chat" to listOf(
                    Message("m1", "mira-chat", mira, "I simplified the transition between the chat list and conversation.", now.minusSeconds(1_400), Delivery.Read, false),
                    Message("m2", "mira-chat", me, "Perfect. It should feel responsive, not theatrical — content first.", now.minusSeconds(1_180), Delivery.Read, true, reactions = listOf(Reaction("✨", 2, false))),
                    Message("m3", "mira-chat", mira, "Exactly. Glass stays with navigation and controls; messages remain quiet and readable.", now.minusSeconds(720), Delivery.Read, false, replyPreview = "It should feel responsive, not theatrical"),
                    Message("m4", "mira-chat", mira, "The motion feels natural now ✦", now.minusSeconds(45), Delivery.Delivered, false),
                ),
                "studio-chat" to listOf(
                    Message("s1", "studio-chat", studio, "Today we are locking the realtime event envelope and delivery semantics.", now.minusSeconds(3_900), Delivery.Read, false),
                ),
                "dispatch-chat" to listOf(
                    Message("d1", "dispatch-chat", dispatch, "Urgency is a user decision, not an engagement lever.", now.minusSeconds(3_600), Delivery.Read, false),
                ),
                "saved" to listOf(
                    Message("x1", "saved", me, "Launch principle: clarity before novelty; privacy before growth.", now.minusSeconds(8_000), Delivery.Read, true),
                ),
            )
            return MessengerState(conversations, messages, me)
        }
    }
}
