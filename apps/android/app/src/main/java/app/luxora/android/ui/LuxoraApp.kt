package app.luxora.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.dp
import app.luxora.android.data.MessengerState
import app.luxora.android.ui.theme.LuxoraDeepViolet
import app.luxora.android.ui.theme.LuxoraViolet

@Composable
fun LuxoraApp(
    state: MessengerState = remember { MessengerState.demo() },
) {
    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.radialGradient(
                    colors = listOf(
                        LuxoraViolet.copy(alpha = 0.16f),
                        LuxoraDeepViolet.copy(alpha = 0.05f),
                        MaterialTheme.colorScheme.background,
                    ),
                    radius = 1_400f,
                ),
            ),
    ) {
        val wide = maxWidth >= 840.dp
        var showConversation by rememberSaveable { mutableStateOf(false) }

        if (wide) {
            Row(Modifier.fillMaxSize()) {
                ChatListPane(
                    state = state,
                    onConversationSelected = state::select,
                    modifier = Modifier.width(352.dp),
                )
                ConversationPane(state = state, showBack = false)
            }
        } else {
            BackHandler(enabled = showConversation) { showConversation = false }
            if (showConversation) {
                ConversationPane(
                    state = state,
                    showBack = true,
                    onBack = { showConversation = false },
                )
            } else {
                ChatListPane(
                    state = state,
                    onConversationSelected = {
                        state.select(it)
                        showConversation = true
                    },
                )
            }
        }
    }
}
