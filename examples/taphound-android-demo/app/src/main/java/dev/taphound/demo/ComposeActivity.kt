package dev.taphound.demo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp

class ComposeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            var status by remember { mutableStateOf("Compose ready") }
            Column(
                modifier = Modifier
                    .semantics { testTagsAsResourceId = true }
                    .padding(24.dp)
            ) {
                Text(status, modifier = Modifier.testTag("compose_status"))
                Button(
                    modifier = Modifier.testTag("compose_action"),
                    onClick = { status = "Compose clicked" }
                ) {
                    Text("Compose action")
                }
                LazyColumn(modifier = Modifier.testTag("compose_list")) {
                    items((1..20).toList()) { index ->
                        Text("Compose row $index", modifier = Modifier.padding(8.dp))
                    }
                }
            }
        }
    }
}
