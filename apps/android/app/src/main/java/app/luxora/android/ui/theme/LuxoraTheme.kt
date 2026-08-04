package app.luxora.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val LuxoraInk = Color(0xFF090914)
val LuxoraDeepViolet = Color(0xFF2F1893)
val LuxoraViolet = Color(0xFF7C48D4)
val LuxoraBlue = Color(0xFF373ABF)
val LuxoraIris = Color(0xFFA999ED)
val LuxoraFrost = Color(0xFFC0C2F7)
val LuxoraAccent = Color(0xFF7657FF)
val LuxoraSuccess = Color(0xFF4CD7A4)

private val DarkColors = darkColorScheme(
    primary = LuxoraAccent,
    onPrimary = Color.White,
    secondary = LuxoraIris,
    background = LuxoraInk,
    surface = Color(0xFF141420),
    surfaceVariant = Color(0xFF20202D),
    outline = Color.White.copy(alpha = 0.14f),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF5B37D1),
    onPrimary = Color.White,
    secondary = LuxoraDeepViolet,
    background = Color(0xFFF8F7FC),
    surface = Color.White,
    surfaceVariant = Color(0xFFEDEAF7),
)

@Composable
fun LuxoraTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = androidx.compose.material3.Typography(),
        content = content,
    )
}
