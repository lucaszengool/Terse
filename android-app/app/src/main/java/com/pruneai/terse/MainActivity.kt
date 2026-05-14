package com.pruneai.terse

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import com.pruneai.terse.auth.TerseAuth
import com.pruneai.terse.ui.AppNavigation

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        TerseAuth.getInstance(this).checkPendingAuth()
        setContent {
            AppNavigation()
        }
    }

    override fun onResume() {
        super.onResume()
        TerseAuth.getInstance(this).checkPendingAuth()
    }
}
