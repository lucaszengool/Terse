package com.pruneai.terse.ui.screens

import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pruneai.terse.auth.TerseAuth
import com.pruneai.terse.core.*
import com.pruneai.terse.ui.components.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun OptimizeScreen() {
    val context = LocalContext.current
    val settings = remember { TerseSettings.getInstance(context) }
    val auth = remember { TerseAuth.getInstance(context) }

    val themeName by settings.theme.collectAsState()
    val theme = TerseThemes.get(themeName)
    val aggressiveness by settings.aggressiveness.collectAsState()

    var inputText by remember { mutableStateOf("") }
    var result by remember { mutableStateOf<OptimizationResult?>(null) }
    var isOptimizing by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }

    val clipboardManager: ClipboardManager = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    val scrollState = rememberScrollState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scrollState),
        verticalArrangement = Arrangement.spacedBy(0.dp)
    ) {
        // Mode selector — underline style, top of screen
        ModeToggle(
            selected = aggressiveness.name.lowercase(),
            onSelect = { mode ->
                settings.setAggressiveness(AggressivenessMode.values().first { it.name.lowercase() == mode })
            },
            theme = theme,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(top = 8.dp)
        )

        Spacer(Modifier.height(20.dp))

        // Input area — surface background, 0.5dp border
        Column(modifier = Modifier.padding(horizontal = 20.dp)) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(theme.surface)
            ) {
                if (inputText.isEmpty()) {
                    Text(
                        "Paste your prompt here…",
                        color = theme.t3.copy(alpha = 0.5f),
                        fontSize = 15.sp,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 16.dp)
                    )
                }
                TextField(
                    value = inputText,
                    onValueChange = { inputText = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = 140.dp),
                    colors = TextFieldDefaults.colors(
                        focusedTextColor = theme.t1,
                        unfocusedTextColor = theme.t1,
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        cursorColor = theme.accent
                    ),
                    textStyle = LocalTextStyle.current.copy(fontSize = 15.sp, color = theme.t1)
                )
            }

            Spacer(Modifier.height(12.dp))

            // Optimize button — full width, accent color
            TerseButton(
                text = if (isOptimizing) "Optimizing…" else "Optimize",
                onClick = {
                    val text = inputText.trim()
                    if (text.isEmpty()) return@TerseButton
                    scope.launch {
                        isOptimizing = true
                        result = null
                        val r = withContext(Dispatchers.Default) {
                            val optimizer = TerseOptimizer()
                            settings.applyTo(optimizer)
                            optimizer.optimize(text)
                        }
                        result = r
                        isOptimizing = false
                        if (r.stats.tokensSaved > 0) {
                            settings.recordOptimization(r.stats.originalTokens, r.stats.optimizedTokens)
                            auth.recordOptimization()
                        }
                        scrollState.animateScrollTo(scrollState.maxValue)
                    }
                },
                theme = theme,
                enabled = !isOptimizing && inputText.trim().isNotEmpty() && auth.canOptimize,
                modifier = Modifier.fillMaxWidth()
            )
        }

        // Results — iOS layout: big % number, token counts, text card, copy button
        AnimatedVisibility(
            visible = result != null,
            enter = fadeIn() + slideInVertically(initialOffsetY = { it / 2 })
        ) {
            result?.let { r ->
                val savedPct = if (r.stats.originalTokens > 0)
                    (r.stats.tokensSaved * 100 / r.stats.originalTokens) else 0

                Column(
                    modifier = Modifier.padding(horizontal = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(0.dp)
                ) {
                    Spacer(Modifier.height(16.dp))

                    // Big savings number — matches iOS "-44%" at 44sp
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.Start
                    ) {
                        Text(
                            "-${savedPct}%",
                            color = theme.t1,
                            fontSize = 44.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            "${r.stats.originalTokens} → ${r.stats.optimizedTokens} tokens",
                            color = theme.t3,
                            fontSize = 14.sp
                        )
                    }

                    Spacer(Modifier.height(16.dp))

                    // Optimized text card
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(theme.surface)
                    ) {
                        SelectionContainer {
                            Text(
                                r.optimized,
                                color = theme.t1,
                                fontSize = 14.sp,
                                lineHeight = 22.sp,
                                modifier = Modifier.padding(14.dp)
                            )
                        }
                    }

                    Spacer(Modifier.height(8.dp))

                    // Copy button — full width, matches iOS
                    Button(
                        onClick = {
                            clipboardManager.setText(AnnotatedString(r.optimized))
                            copied = true
                            scope.launch { delay(1500); copied = false }
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (copied) theme.accent else Color.White.copy(alpha = 0.25f),
                            contentColor = if (copied) Color.White else theme.t2
                        ),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth().height(44.dp)
                    ) {
                        Text(
                            if (copied) "Copied" else "Copy",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(30.dp))
    }
}
