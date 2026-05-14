package com.pruneai.terse.ui.screens

import android.content.Intent
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pruneai.terse.R
import com.pruneai.terse.core.TerseSettings
import com.pruneai.terse.core.TerseThemes
import com.pruneai.terse.ui.components.*

@Composable
fun KeyboardSetupScreen(onDismiss: (() -> Unit)? = null) {
    val context = LocalContext.current
    val settings = remember { TerseSettings.getInstance(context) }
    val themeName by settings.theme.collectAsState()
    val theme = TerseThemes.get(themeName)

    val imm = context.getSystemService(InputMethodManager::class.java)
    val isKeyboardEnabled = remember {
        mutableStateOf(
            imm?.enabledInputMethodList?.any {
                it.packageName == context.packageName
            } ?: false
        )
    }

    // Refresh on resume
    LaunchedEffect(Unit) {
        isKeyboardEnabled.value = imm?.enabledInputMethodList?.any {
            it.packageName == context.packageName
        } ?: false
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            stringResource(R.string.keyboard_setup_title),
            color = theme.t1,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(vertical = 8.dp)
        )
        Text(
            stringResource(R.string.keyboard_setup_subtitle),
            color = theme.t2,
            fontSize = 15.sp
        )

        if (isKeyboardEnabled.value) {
            GlassCard(theme, modifier = Modifier.fillMaxWidth()) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier.size(40.dp).clip(CircleShape).background(theme.accent.copy(alpha = 0.15f))
                    ) {
                        Icon(Icons.Default.Check, contentDescription = null, tint = theme.accent)
                    }
                    Column {
                        Text(stringResource(R.string.keyboard_setup_done), color = theme.accent, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        Text("Terse Keyboard is active", color = theme.t2, fontSize = 13.sp)
                    }
                }
            }
        }

        // Step 1
        SetupStep(
            number = 1,
            title = "Open Language & Input Settings",
            description = "Go to Settings → General Management → Keyboard list and default → On-screen keyboard → Add keyboard.",
            isDone = false,
            theme = theme
        )

        // Step 2
        SetupStep(
            number = 2,
            title = "Add Terse Keyboard",
            description = "Tap \"Terse Keyboard\" from the list of available keyboards and enable it.",
            isDone = false,
            theme = theme
        )

        // Step 3
        SetupStep(
            number = 3,
            title = "Switch to PruneAI",
            description = "Open any text field, tap the keyboard icon in the navigation bar, and select Terse Keyboard.",
            isDone = isKeyboardEnabled.value,
            theme = theme
        )

        TerseButton(
            text = stringResource(R.string.keyboard_setup_open_settings),
            onClick = {
                val intent = Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)
                context.startActivity(intent)
            },
            theme = theme,
            modifier = Modifier.fillMaxWidth()
        )

        if (onDismiss != null) {
            TerseButton(
                text = "Done",
                onClick = onDismiss,
                theme = theme,
                modifier = Modifier.fillMaxWidth()
            )
        }

        // Privacy note
        GlassCard(theme, modifier = Modifier.fillMaxWidth()) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Top
            ) {
                Text("🔒", fontSize = 16.sp)
                Text(
                    stringResource(R.string.keyboard_setup_privacy),
                    color = theme.t2,
                    fontSize = 13.sp,
                    lineHeight = 20.sp
                )
            }
        }

        Spacer(Modifier.height(80.dp))
    }
}

@Composable
private fun SetupStep(
    number: Int,
    title: String,
    description: String,
    isDone: Boolean,
    theme: com.pruneai.terse.core.TerseTheme
) {
    val circleColor by animateColorAsState(
        targetValue = if (isDone) theme.accent else theme.surface,
        label = "stepColor"
    )

    Row(
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(circleColor)
        ) {
            if (isDone) {
                Icon(Icons.Default.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
            } else {
                Text(
                    number.toString(),
                    color = if (isDone) Color.White else theme.t2,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = theme.t1, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(2.dp))
            Text(description, color = theme.t2, fontSize = 13.sp, lineHeight = 20.sp)
        }
    }
}
