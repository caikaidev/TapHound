package dev.apr.demo

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.TextView

class SearchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_search)

        val input = findViewById<EditText>(R.id.search_input)
        val result = findViewById<TextView>(R.id.search_result)
        findViewById<Button>(R.id.submit_search).setOnClickListener {
            val query = input.text.toString()
            result.text = query
            Log.i("SearchViewModel", "submitted query=$query")
        }
    }
}
