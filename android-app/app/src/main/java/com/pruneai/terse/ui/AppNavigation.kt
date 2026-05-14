package com.pruneai.terse.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pruneai.terse.auth.TerseAuth
import com.pruneai.terse.core.TerseSettings
import com.pruneai.terse.core.TerseThemes
import com.pruneai.terse.ui.components.AppBackground
import com.pruneai.terse.ui.screens.*

@Composable
fun AppNavigation() {
    val context = LocalContext.current
    val auth = remember { TerseAuth.getInstance(context) }
    val settings = remember { TerseSettings.getInstance(context) }

    val isSignedIn by auth.isSignedIn.collectAsState()
    val themeName by settings.theme.collectAsState()
    val theme = TerseThemes.get(themeName)

    if (!isSignedIn) {
        SignInScreen()
        return
    }

    var selectedTab by remember { mutableIntStateOf(0) }
    var showKeyboardSetup by remember { mutableStateOf(false) }

    val totalOptimizations by settings.totalOptimizations.collectAsState()
    val tier by auth.tier.collectAsState()
    val usageText = auth.usageText

    val keyboardInstalled = remember(context) { isKeyboardEnabled(context) }

    LaunchedEffect(isSignedIn) {
        if (isSignedIn) {
            auth.verifyLicense()
            if (!keyboardInstalled && !settings.hasSeenSetup.value) {
                showKeyboardSetup = true
            }
        }
    }

    if (showKeyboardSetup) {
        KeyboardSetupScreen(onDismiss = {
            showKeyboardSetup = false
            settings.setHasSeenSetup(true)
        })
        return
    }

    AppBackground(theme) {
        Column(modifier = Modifier.fillMaxSize()) {

            // ── Hero Header ──
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp)
                    .padding(top = 12.dp, bottom = 12.dp),
                verticalArrangement = Arrangement.spacedBy(0.dp)
            ) {
                // Top row: logo + name | status dot + PRO pill
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // Logo box + app name
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier
                                .size(28.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(theme.accent)
                        ) {
                            Text("T", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        }
                        Text(
                            "Terse",
                            color = theme.t1,
                            fontSize = 20.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    Spacer(Modifier.weight(1f))

                    // Orange dot if keyboard not installed
                    if (!keyboardInstalled) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(Color(0xFFF97316))
                        )
                        Spacer(Modifier.width(8.dp))
                    }

                    // PRO pill for free users
                    if (tier == "free") {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier
                                .clip(RoundedCornerShape(20.dp))
                                .background(theme.accent)
                                .padding(horizontal = 10.dp, vertical = 5.dp)
                                .clickable { selectedTab = 2 }
                        ) {
                            Text("PRO", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }

                // Total optimizations big number
                if (totalOptimizations > 0) {
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            "$totalOptimizations",
                            color = theme.t1,
                            fontSize = 32.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Text(
                            "optimizations saved",
                            color = theme.t3,
                            fontSize = 13.sp,
                            modifier = Modifier.padding(bottom = 4.dp)
                        )
                    }
                }

                // Quota text
                Spacer(Modifier.height(2.dp))
                Text(usageText, color = theme.t3, fontSize = 12.sp)

                // Keyboard setup banner
                if (!keyboardInstalled) {
                    Spacer(Modifier.height(8.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(theme.accent.copy(alpha = 0.08f))
                            .clickable { showKeyboardSetup = true }
                            .padding(12.dp)
                    ) {
                        Text("⌨️", fontSize = 13.sp)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "Set up keyboard",
                            color = theme.accent,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.weight(1f)
                        )
                        Text("›", color = theme.accent, fontSize = 16.sp)
                    }
                }
            }

            // ── Tab Content ──
            Box(modifier = Modifier.weight(1f)) {
                when (selectedTab) {
                    0 -> OptimizeScreen()
                    1 -> StatsScreen()
                    2 -> SettingsScreen(onUpgrade = {
                        auth.startCheckout { url ->
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        }
                    })
                }
            }

            // ── Minimal Tab Bar — icon + active dot, no labels ──
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 40.dp, vertical = 0.dp)
                    .padding(bottom = 8.dp),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                TabBarItem(
                    icon = Icons.Default.AutoAwesome,
                    selected = selectedTab == 0,
                    theme = theme,
                    onClick = { selectedTab = 0 }
                )
                TabBarItem(
                    icon = Icons.Default.BarChart,
                    selected = selectedTab == 1,
                    theme = theme,
                    onClick = { selectedTab = 1 }
                )
                TabBarItem(
                    icon = Icons.Default.Settings,
                    selected = selectedTab == 2,
                    theme = theme,
                    onClick = { selectedTab = 2 }
                )
            }
        }
    }
}

@Composable
private fun RowScope.TabBarItem(
    icon: ImageVector,
    selected: Boolean,
    theme: com.pruneai.terse.core.TerseTheme,
    onClick: () -> Unit
) {
    val iconColor by animateColorAsState(
        targetValue = if (selected) theme.accent else theme.t3.copy(alpha = 0.5f),
        animationSpec = spring(stiffness = 400f),
        label = "tabColor"
    )

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .weight(1f)
            .clickable(indication = null, interactionSource = null) { onClick() }
            .padding(vertical = 10.dp)
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = iconColor,
            modifier = Modifier.size(if (selected) 20.dp else 18.dp)
        )
        Spacer(Modifier.height(3.dp))
        Box(
            modifier = Modifier
                .size(4.dp)
                .clip(CircleShape)
                .background(if (selected) theme.accent else Color.Transparent)
        )
    }
}

private fun isKeyboardEnabled(context: Context): Boolean {
    val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_INPUT_METHODS
    ) ?: return false
    return enabled.contains("com.pruneai.terse")
}
