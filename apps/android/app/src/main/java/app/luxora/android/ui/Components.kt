package app.luxora.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.luxora.android.model.Participant
import app.luxora.android.ui.theme.LuxoraDeepViolet
import app.luxora.android.ui.theme.LuxoraSuccess

@Composable
fun Avatar(
    participant: Participant,
    size: Dp = 48.dp,
    showPresence: Boolean = true,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier.size(size)) {
        Box(
            modifier = Modifier
                .matchParentSize()
                .clip(CircleShape)
                .background(
                    Brush.linearGradient(
                        listOf(Color(participant.accent), LuxoraDeepViolet),
                    ),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = participant.initials,
                color = Color.White,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
            )
        }

        if (showPresence && participant.online) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(size * 0.25f)
                    .clip(CircleShape)
                    .background(LuxoraSuccess)
                    .border(2.dp, MaterialTheme.colorScheme.background, CircleShape),
            )
        }
    }
}
