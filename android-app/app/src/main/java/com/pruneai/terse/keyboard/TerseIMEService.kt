package com.pruneai.terse.keyboard

import android.inputmethodservice.InputMethodService
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.*
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import com.pruneai.terse.core.*
import kotlinx.coroutines.*

class TerseIMEService : InputMethodService(), LifecycleOwner, SavedStateRegistryOwner {

    private val lifecycleRegistry = LifecycleRegistry(this)
    private val savedStateController = SavedStateRegistryController.create(this)

    override val lifecycle: Lifecycle get() = lifecycleRegistry
    override val savedStateRegistry: SavedStateRegistry get() = savedStateController.savedStateRegistry

    private lateinit var settings: TerseSettings
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private var pendingOptimizedText: String? = null
    private var isTwoTapState = false

    override fun onCreate() {
        savedStateController.performRestore(null)
        super.onCreate()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
        settings = TerseSettings.getInstance(applicationContext)
    }

    override fun onCreateInputView(): View {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)

        return ComposeView(this).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            setContent {
                val themeName by settings.theme.collectAsState()
                val theme = TerseThemes.get(themeName)
                val aggressiveness by settings.aggressiveness.collectAsState()

                var mode by remember { mutableStateOf(aggressiveness.name.lowercase()) }
                var tokensSaved by remember { mutableIntStateOf(0) }
                var percentSaved by remember { mutableIntStateOf(0) }
                var isOptimizing by remember { mutableStateOf(false) }
                var showQuotaBlock by remember { mutableStateOf(false) }

                LaunchedEffect(aggressiveness) { mode = aggressiveness.name.lowercase() }

                TerseKeyboardLayout(
                    theme = theme,
                    mode = mode,
                    tokensSaved = tokensSaved,
                    percentSaved = percentSaved,
                    isOptimizing = isOptimizing,
                    isTwoTapState = isTwoTapState,
                    showQuotaBlock = showQuotaBlock,
                    onModeChange = { newMode ->
                        mode = newMode
                        val newAgg = AggressivenessMode.values().firstOrNull { it.name.lowercase() == newMode }
                            ?: AggressivenessMode.BALANCED
                        settings.setAggressiveness(newAgg)
                    },
                    onKey = { key ->
                        haptic()
                        handleKey(key)
                    },
                    onBackspace = {
                        haptic()
                        val ic = currentInputConnection ?: return@TerseKeyboardLayout
                        ic.deleteSurroundingText(1, 0)
                    },
                    onSpace = {
                        haptic()
                        val ic = currentInputConnection ?: return@TerseKeyboardLayout
                        ic.commitText(" ", 1)
                    },
                    onSendOrOptimize = {
                        haptic()
                        handleSendOrOptimize(
                            onTokensSaved = { ts, pct -> tokensSaved = ts; percentSaved = pct },
                            onOptimizing = { isOptimizing = it },
                            onQuotaReached = { showQuotaBlock = true }
                        )
                    },
                    onThemeCycle = {
                        val allThemes = TerseThemeName.values()
                        val currentIdx = allThemes.indexOf(settings.theme.value)
                        val nextIdx = (currentIdx + 1) % allThemes.size
                        settings.setTheme(allThemes[nextIdx])
                    }
                )
            }
        }
    }

    private fun handleKey(key: String) {
        val ic = currentInputConnection ?: return
        ic.commitText(key, 1)
    }

    private fun handleSendOrOptimize(
        onTokensSaved: (Int, Int) -> Unit,
        onOptimizing: (Boolean) -> Unit,
        onQuotaReached: () -> Unit
    ) {
        val ic = currentInputConnection ?: return

        if (isTwoTapState && pendingOptimizedText != null) {
            // Second tap: commit the optimized text and send
            val optimized = pendingOptimizedText!!
            val textLength = ic.getTextBeforeCursor(99999, 0)?.length ?: 0
            ic.deleteSurroundingText(textLength, 0)
            ic.commitText(optimized, 1)
            ic.performEditorAction(currentInputEditorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_SEND)
            pendingOptimizedText = null
            isTwoTapState = false
        } else {
            // First tap: read text and optimize
            val text = ic.getTextBeforeCursor(99999, 0)?.toString() ?: ""
            if (text.trim().isEmpty()) {
                ic.performEditorAction(currentInputEditorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_SEND)
                return
            }

            scope.launch {
                onOptimizing(true)
                val result = withContext(Dispatchers.Default) {
                    val optimizer = TerseOptimizer()
                    settings.applyTo(optimizer)
                    optimizer.optimize(text)
                }
                onOptimizing(false)
                if (result.stats.percentSaved > 0) {
                    onTokensSaved(result.stats.tokensSaved, result.stats.percentSaved)
                    pendingOptimizedText = result.optimized
                    isTwoTapState = true
                } else {
                    ic.performEditorAction(currentInputEditorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_SEND)
                }
            }
        }
    }

    private fun haptic() {
        if (!settings.hapticFeedback.value) return
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(VIBRATOR_SERVICE) as? Vibrator
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createOneShot(20, 80))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(20)
        }
    }

    override fun onFinishInputView(finishingInput: Boolean) {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        pendingOptimizedText = null
        isTwoTapState = false
        super.onFinishInputView(finishingInput)
    }

    override fun onDestroy() {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
        scope.cancel()
        super.onDestroy()
    }
}

@Composable
private fun TerseKeyboardLayout(
    theme: TerseTheme,
    mode: String,
    tokensSaved: Int,
    percentSaved: Int,
    isOptimizing: Boolean,
    isTwoTapState: Boolean,
    showQuotaBlock: Boolean,
    onModeChange: (String) -> Unit,
    onKey: (String) -> Unit,
    onBackspace: () -> Unit,
    onSpace: () -> Unit,
    onSendOrOptimize: () -> Unit,
    onThemeCycle: () -> Unit
) {
    var isUppercase by remember { mutableStateOf(true) }
    var showNumbers by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(theme.bg.copy(alpha = 0.97f))
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp)
        ) {
            // Toolbar
            KeyboardToolbar(
                theme = theme,
                mode = mode,
                tokensSaved = tokensSaved,
                percentSaved = percentSaved,
                isTwoTapState = isTwoTapState,
                onModeChange = onModeChange,
                onThemeCycle = onThemeCycle
            )

            if (showNumbers) {
                NumbersRow(theme, onKey, onBackspace, onShowLetters = { showNumbers = false })
            } else {
                LettersRows(
                    theme = theme,
                    isUppercase = isUppercase,
                    onKey = { key ->
                        onKey(if (isUppercase) key.uppercase() else key)
                        if (isUppercase) isUppercase = false
                    },
                    onShift = { isUppercase = !isUppercase },
                    onBackspace = onBackspace
                )
            }

            BottomRow(
                theme = theme,
                showNumbers = showNumbers,
                isOptimizing = isOptimizing,
                isTwoTapState = isTwoTapState,
                onToggleNumbers = { showNumbers = !showNumbers },
                onSpace = onSpace,
                onSendOrOptimize = onSendOrOptimize
            )
        }

        // Quota block overlay
        if (showQuotaBlock) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .matchParentSize()
                    .background(Color.Black.copy(alpha = 0.85f))
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(16.dp)) {
                    Text("🔒", fontSize = 32.sp)
                    Spacer(Modifier.height(8.dp))
                    Text("Weekly quota reached", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Text("Upgrade to Pro for unlimited", color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp)
                }
            }
        }
    }
}

@Composable
private fun KeyboardToolbar(
    theme: TerseTheme,
    mode: String,
    tokensSaved: Int,
    percentSaved: Int,
    isTwoTapState: Boolean,
    onModeChange: (String) -> Unit,
    onThemeCycle: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        // Theme cycler
        KeyboardButton(
            text = "◐",
            theme = theme,
            modifier = Modifier.size(34.dp),
            onClick = onThemeCycle
        )

        // Mode selector: S / N / A
        Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(theme.surface)
                .padding(3.dp)
        ) {
            listOf("light" to "S", "balanced" to "N", "aggressive" to "A").forEach { (key, label) ->
                val selected = mode == key
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(26.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (selected) theme.btn else Color.Transparent)
                        .clickable { onModeChange(key) }
                ) {
                    Text(
                        label,
                        color = if (selected) theme.btnText else theme.t3,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }

        Spacer(Modifier.weight(1f))

        // Token savings indicator
        AnimatedVisibility(visible = isTwoTapState && percentSaved > 0) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(theme.accent.copy(alpha = 0.15f))
                    .padding(horizontal = 10.dp, vertical = 4.dp)
            ) {
                Text("🪙", fontSize = 13.sp)
                Text("-$percentSaved%", color = theme.accent, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
        }

        if (!isTwoTapState) {
            Text(
                "Send = Optimize",
                color = theme.t3,
                fontSize = 11.sp
            )
        } else {
            Text(
                "Tap again to send",
                color = theme.accent,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

@Composable
private fun LettersRows(
    theme: TerseTheme,
    isUppercase: Boolean,
    onKey: (String) -> Unit,
    onShift: () -> Unit,
    onBackspace: () -> Unit
) {
    val rows = listOf(
        listOf("q","w","e","r","t","y","u","i","o","p"),
        listOf("a","s","d","f","g","h","j","k","l"),
        listOf("z","x","c","v","b","n","m")
    )

    rows.forEachIndexed { rowIndex, row ->
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.Center
        ) {
            if (rowIndex == 2) {
                // Shift key
                KeyboardButton(
                    text = if (isUppercase) "⇧" else "⇧",
                    theme = theme,
                    modifier = Modifier.size(width = 42.dp, height = 40.dp),
                    highlighted = isUppercase,
                    onClick = onShift
                )
                Spacer(Modifier.width(4.dp))
            }
            row.forEach { key ->
                KeyboardButton(
                    text = if (isUppercase) key.uppercase() else key,
                    theme = theme,
                    modifier = Modifier
                        .padding(horizontal = 2.dp)
                        .size(width = 32.dp, height = 40.dp),
                    onClick = { onKey(key) }
                )
            }
            if (rowIndex == 2) {
                Spacer(Modifier.width(4.dp))
                // Backspace
                KeyboardButton(
                    text = "⌫",
                    theme = theme,
                    modifier = Modifier.size(width = 42.dp, height = 40.dp),
                    onClick = onBackspace
                )
            }
        }
    }
}

@Composable
private fun NumbersRow(
    theme: TerseTheme,
    onKey: (String) -> Unit,
    onBackspace: () -> Unit,
    onShowLetters: () -> Unit
) {
    val rows = listOf(
        listOf("1","2","3","4","5","6","7","8","9","0"),
        listOf("-","/",":",";","(",")","\$","&","@","\""),
        listOf(".",",","?","!","'")
    )
    rows.forEachIndexed { i, row ->
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.Center
        ) {
            if (i == 2) {
                KeyboardButton(text = "ABC", theme = theme, modifier = Modifier.size(width = 42.dp, height = 40.dp), onClick = onShowLetters)
                Spacer(Modifier.width(4.dp))
            }
            row.forEach { key ->
                KeyboardButton(
                    text = key,
                    theme = theme,
                    modifier = Modifier.padding(horizontal = 2.dp).size(width = 32.dp, height = 40.dp),
                    onClick = { onKey(key) }
                )
            }
            if (i == 2) {
                Spacer(Modifier.width(4.dp))
                KeyboardButton(text = "⌫", theme = theme, modifier = Modifier.size(width = 42.dp, height = 40.dp), onClick = onBackspace)
            }
        }
    }
}

@Composable
private fun BottomRow(
    theme: TerseTheme,
    showNumbers: Boolean,
    isOptimizing: Boolean,
    isTwoTapState: Boolean,
    onToggleNumbers: () -> Unit,
    onSpace: () -> Unit,
    onSendOrOptimize: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        KeyboardButton(
            text = if (showNumbers) "ABC" else "123",
            theme = theme,
            modifier = Modifier.size(width = 42.dp, height = 44.dp),
            onClick = onToggleNumbers
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .height(44.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(theme.surface)
                .border(1.dp, theme.border, RoundedCornerShape(8.dp))
                .clickable { onSpace() }
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(width = 80.dp, height = 44.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(if (isTwoTapState) theme.accent else theme.btn)
                .clickable(enabled = !isOptimizing) { onSendOrOptimize() }
        ) {
            if (isOptimizing) {
                Text("…", color = theme.btnText, fontSize = 14.sp)
            } else {
                Text(
                    if (isTwoTapState) "Send" else "✂ Send",
                    color = if (isTwoTapState) Color.White else theme.btnText,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }
        }
    }
}

@Composable
private fun KeyboardButton(
    text: String,
    theme: TerseTheme,
    modifier: Modifier = Modifier,
    highlighted: Boolean = false,
    onClick: () -> Unit
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (highlighted) theme.accent.copy(alpha = 0.2f) else theme.surface)
            .border(0.5.dp, theme.border, RoundedCornerShape(6.dp))
            .clickable { onClick() }
    ) {
        Text(
            text,
            color = theme.t1,
            fontSize = 16.sp,
            fontWeight = FontWeight.Normal
        )
    }
}
