package app.luxora.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.luxora.android.ui.LuxoraApp
import app.luxora.android.ui.theme.LuxoraTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            LuxoraTheme {
                LuxoraApp()
            }
        }
    }
}
