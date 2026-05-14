package com.pruneai.terse.share

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pruneai.terse.core.*
import com.pruneai.terse.ui.components.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class TerseShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val sharedText = when {
            intent?.action == Intent.ACTION_SEND && intent.type == "text/plain" ->
                intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
            else -> ""
        }

        setContent {
            ShareScreen(
                initialText = sharedText,
                onDismiss = { finish() }
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ShareScreen(initialText: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val settings = remember { TerseSettings.getInstance(context) }
    val themeName by settings.theme.collectAsState()
    val theme = TerseThemes.get(themeName)
    val aggressiveness by settings.aggressiveness.collectAsState()

    var result by remember { mutableStateOf<OptimizationResult?>(null) }
    var isOptimizing by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    val clipboardManager: ClipboardManager = LocalClipboardManager.current
    val scope = rememberCoroutineScope()

    LaunchedEffect(initialText) {
        if (initialText.trim().isNotEmpty()) {
            isOptimizing = true
            result = withContext(Dispatchers.Default) {
                val optimizer = TerseOptimizer()
                settings.applyTo(optimizer)
                optimizer.optimize(initialText)
            }
            isOptimizing = false
            result?.let {
                if (it.stats.tokensSaved > 0) {
                    settings.recordOptimization(it.stats.originalTokens, it.stats.optimizedTokens)
                }
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = theme.bg,
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("Optimize with Terse", color = theme.t1, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Default.Close, contentDescription = "Close", tint = theme.t2)
                }
            }

            // Mode selector
            ModeToggle(
                selected = aggressiveness.name.lowercase(),
                onSelect = { mode ->
                    settings.setAggressiveness(AggressivenessMode.values().first { it.name.lowercase() == mode })
                },
                theme = theme,
                modifier = Modifier.fillMaxWidth()
            )

            // Original text preview
            GlassCard(theme, modifier = Modifier.fillMaxWidth()) {
                Text("Original", color = theme.t3, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(4.dp))
                SelectionContainer {
                    Text(initialText.take(300) + if (initialText.length > 300) "…" else "", color = theme.t2, fontSize = 13.sp)
                }
            }

            if (isOptimizing) {
                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = theme.accent)
                }
            }

            result?.let { r ->
                val savedPct = if (r.stats.originalTokens > 0)
                    (r.stats.tokensSaved * 100 / r.stats.originalTokens) else 0

                Text("-${savedPct}%", color = theme.t1, fontSize = 36.sp, fontWeight = FontWeight.Bold)
                Text("${r.stats.originalTokens} → ${r.stats.optimizedTokens} tokens",
                    color = theme.t3, fontSize = 13.sp, modifier = Modifier.padding(bottom = 8.dp))

                GlassCard(theme, modifier = Modifier.fillMaxWidth()) {
                    SelectionContainer {
                        Text(r.optimized, color = theme.t1, fontSize = 14.sp, lineHeight = 22.sp,
                            modifier = Modifier.padding(14.dp))
                    }
                }

                Spacer(Modifier.height(8.dp))

                TerseButton(
                    text = if (copied) "Copied!" else "Copy optimized text",
                    onClick = {
                        clipboardManager.setText(AnnotatedString(r.optimized))
                        copied = true
                        scope.launch { delay(2000); copied = false }
                    },
                    theme = theme,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }
    }
}
