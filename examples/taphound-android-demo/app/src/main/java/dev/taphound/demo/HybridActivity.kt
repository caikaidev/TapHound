package dev.taphound.demo

import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button as ComposeButton
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp

class HybridActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_hybrid)
        val status = findViewById<TextView>(R.id.hybrid_status)
        findViewById<Button>(R.id.hybrid_view_action).setOnClickListener {
            status.text = "View clicked"
        }
        findViewById<ComposeView>(R.id.hybrid_compose).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            setContent {
                Column(
                    modifier = Modifier
                        .semantics { testTagsAsResourceId = true }
                        .padding(16.dp)
                ) {
                    Text("Compose inside View", Modifier.testTag("hybrid_compose_label"))
                    ComposeButton(
                        modifier = Modifier.testTag("hybrid_compose_action"),
                        onClick = { status.text = "Compose clicked" }
                    ) {
                        Text("Hybrid Compose action")
                    }
                }
            }
        }
    }
}
