package dev.taphound.demo

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        findViewById<Button>(R.id.open_search).setOnClickListener {
            startActivity(Intent(this, SearchActivity::class.java))
        }
        findViewById<Button>(R.id.open_compose).setOnClickListener {
            startActivity(Intent(this, ComposeActivity::class.java))
        }
        findViewById<Button>(R.id.open_hybrid).setOnClickListener {
            startActivity(Intent(this, HybridActivity::class.java))
        }
    }
}
