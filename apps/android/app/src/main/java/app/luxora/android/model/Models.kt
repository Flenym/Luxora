package app.luxora.android.model

import java.time.Instant
import java.util.UUID

enum class ConversationKind { Direct, Group, Channel, Saved }

enum class Delivery { Sending, Sent, Delivered, Read, Failed }

data class Participant(
    val id: String,
    val name: String,
    val username: String,
    val initials: String,
    val accent: Long,
    val online: Boolean,
    val status: String,
)

data class Conversation(
    val id: String,
    val title: String,
    var preview: String,
    val kind: ConversationKind,
    val participant: Participant,
    val folder: String,
    val members: Int,
    var unread: Int,
    val pinned: Boolean,
    val muted: Boolean,
    val typing: Boolean,
    var updatedAt: Instant,
)

data class Reaction(
    val emoji: String,
    var count: Int,
    var mine: Boolean,
)

data class Message(
    val id: String = UUID.randomUUID().toString(),
    val conversationId: String,
    val author: Participant,
    val text: String,
    val sentAt: Instant,
    var delivery: Delivery,
    val outgoing: Boolean,
    val replyPreview: String? = null,
    val reactions: List<Reaction> = emptyList(),
)
