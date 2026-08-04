package app.luxora.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.SentimentSatisfied
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.luxora.android.data.MessengerState
import app.luxora.android.model.Delivery
import app.luxora.android.model.Message
import app.luxora.android.ui.theme.LuxoraAccent
import app.luxora.android.ui.theme.LuxoraBlue
import app.luxora.android.ui.theme.LuxoraIris
import app.luxora.android.ui.theme.LuxoraViolet
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun ConversationPane(
    state: MessengerState,
    showBack: Boolean,
    onBack: () -> Unit = {},
) {
    val conversation = state.selectedConversation
    if (conversation == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Choose a conversation", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.84f))
                .padding(horizontal = 8.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (showBack) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            }
            Avatar(conversation.participant, size = 38.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    conversation.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    if (conversation.typing) "typing…" else conversation.participant.status,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (conversation.typing) LuxoraAccent else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = {}, enabled = false) {
                Icon(Icons.Default.Phone, contentDescription = "Audio call — waiting for server call platform")
            }
            IconButton(onClick = {}, enabled = false) {
                Icon(Icons.Default.Videocam, contentDescription = "Video call — waiting for server call platform")
            }
            IconButton(onClick = {}, enabled = false) {
                Icon(Icons.Default.Info, contentDescription = "Details — not available in this portability probe")
            }
        }

        val listState = rememberLazyListState()
        LaunchedEffect(state.selectedMessages.size, conversation.id) {
            if (state.selectedMessages.isNotEmpty()) {
                listState.animateScrollToItem(state.selectedMessages.lastIndex)
            }
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item(key = "date") {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.68f),
                        shape = CircleShape,
                    ) {
                        Text("Today", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 11.dp, vertical = 5.dp))
                    }
                }
            }
            items(state.selectedMessages, key = { it.id }) { message ->
                MessageBubble(message)
            }
        }

        Composer(state)
    }
}

@Composable
private fun MessageBubble(message: Message) {
    Row(Modifier.fillMaxWidth()) {
        if (message.outgoing) Spacer(Modifier.weight(0.16f))
        if (!message.outgoing) {
            Avatar(message.author, size = 28.dp, showPresence = false, modifier = Modifier.align(Alignment.Bottom))
            Spacer(Modifier.width(7.dp))
        }

        Column(horizontalAlignment = if (message.outgoing) Alignment.End else Alignment.Start) {
            ElevatedCard(
                shape = RoundedCornerShape(
                    topStart = 19.dp,
                    topEnd = 19.dp,
                    bottomStart = if (message.outgoing) 19.dp else 5.dp,
                    bottomEnd = if (message.outgoing) 5.dp else 19.dp,
                ),
                colors = CardDefaults.elevatedCardColors(
                    containerColor = if (message.outgoing) Color.Transparent else MaterialTheme.colorScheme.surface,
                ),
                elevation = CardDefaults.elevatedCardElevation(defaultElevation = 3.dp),
            ) {
                Column(
                    modifier = Modifier
                        .then(
                            if (message.outgoing) {
                                Modifier.background(Brush.linearGradient(listOf(LuxoraBlue, LuxoraViolet, LuxoraIris)))
                            } else Modifier
                        )
                        .padding(horizontal = 13.dp, vertical = 9.dp),
                ) {
                    message.replyPreview?.let { reply ->
                        Text(
                            reply,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (message.outgoing) Color.White.copy(alpha = 0.76f) else LuxoraIris,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(bottom = 5.dp),
                        )
                    }
                    Text(
                        message.text,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (message.outgoing) Color.White else MaterialTheme.colorScheme.onSurface,
                    )
                    Row(
                        modifier = Modifier.align(Alignment.End).padding(top = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(message.sentAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (message.outgoing) Color.White.copy(alpha = 0.7f) else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (message.outgoing) {
                            Spacer(Modifier.width(4.dp))
                            Icon(
                                Icons.Default.CheckCircle,
                                contentDescription = message.delivery.name,
                                modifier = Modifier.size(13.dp),
                                tint = if (message.delivery == Delivery.Read) Color.White else Color.White.copy(alpha = 0.6f),
                            )
                        }
                    }
                }
            }
            if (message.reactions.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 3.dp)) {
                    message.reactions.forEach { reaction ->
                        Surface(
                            color = if (reaction.mine) LuxoraAccent.copy(alpha = 0.22f) else MaterialTheme.colorScheme.surfaceVariant,
                            shape = CircleShape,
                        ) {
                            Text("${reaction.emoji} ${reaction.count}", style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 7.dp, vertical = 4.dp))
                        }
                    }
                }
            }
        }
        if (!message.outgoing) Spacer(Modifier.weight(0.16f))
    }
}

@Composable
private fun Composer(state: MessengerState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f))
            .navigationBarsPadding()
            .imePadding()
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        IconButton(
            onClick = {},
            enabled = false,
            modifier = Modifier.clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Icon(Icons.Default.AttachFile, contentDescription = "Attach — waiting for server media platform")
        }
        Spacer(Modifier.width(7.dp))
        TextField(
            value = state.draft,
            onValueChange = { state.draft = it },
            placeholder = { Text("Message") },
            trailingIcon = { Icon(Icons.Default.SentimentSatisfied, contentDescription = "Emoji") },
            shape = RoundedCornerShape(23.dp),
            colors = TextFieldDefaults.colors(
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.74f),
                unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.74f),
            ),
            maxLines = 5,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { state.sendDraft() }),
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(7.dp))
        IconButton(
            onClick = { state.sendDraft() },
            modifier = Modifier
                .clip(CircleShape)
                .background(Brush.linearGradient(listOf(LuxoraBlue, LuxoraViolet))),
        ) {
            Icon(
                if (state.draft.isBlank()) Icons.Default.Mic else Icons.Default.ArrowUpward,
                contentDescription = if (state.draft.isBlank()) "Record voice message" else "Send",
                tint = Color.White,
            )
        }
    }
}
