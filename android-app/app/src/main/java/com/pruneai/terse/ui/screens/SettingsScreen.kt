package com.pruneai.terse.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pruneai.terse.auth.TerseAuth
import com.pruneai.terse.core.AggressivenessMode
import com.pruneai.terse.core.TerseSettings
import com.pruneai.terse.core.TerseThemes
import com.pruneai.terse.ui.components.*

@Composable
fun SettingsScreen(onUpgrade: () -> Unit = {}) {
    val context = LocalContext.current
    val settings = remember { TerseSettings.getInstance(context) }
    val auth = remember { TerseAuth.getInstance(context) }

    val themeName by settings.theme.collectAsState()
    val theme = TerseThemes.get(themeName)
    val aggressiveness by settings.aggressiveness.collectAsState()
    val tier by auth.tier.collectAsState()
    val email by auth.email.collectAsState()
    val firstName by auth.firstName.collectAsState()

    val remaining by auth.remaining.collectAsState()
    var showDeleteDialog by remember { mutableStateOf(false) }

    if (showDeleteDialog) {
        AlertDialog(
            onDismissRequest = { showDeleteDialog = false },
            title = { Text("Delete Account") },
            text = { Text("This will permanently delete your account and all associated data. This action cannot be undone.") },
            confirmButton = {
                TextButton(onClick = { auth.deleteAccount(); showDeleteDialog = false }) {
                    Text("Delete", color = Color.Red)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteDialog = false }) { Text("Cancel") }
            }
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
    ) {
        // Header
        Text(
            "Settings",
            color = theme.t1,
            fontSize = 24.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp)
        )

        // ── ACCOUNT ──
        SectionBlock(theme, "ACCOUNT") {

            // User info row
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp)
            ) {
                // Avatar — letter in rounded rect, matches iOS
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(theme.surface)
                ) {
                    Text(
                        (firstName?.firstOrNull() ?: email?.firstOrNull() ?: '?').uppercaseChar().toString(),
                        color = theme.t1,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                }

                Column(modifier = Modifier.weight(1f)) {
                    Text(firstName ?: "User", color = theme.t1, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    Text(email ?: "", color = theme.t3, fontSize = 11.sp)
                }

                // Tier badge — capsule
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(
                            when (tier) {
                                "free" -> Color.Gray
                                "pro" -> theme.accent
                                else -> Color(0xFF7C3AED)
                            }
                        )
                        .padding(horizontal = 10.dp, vertical = 4.dp)
                ) {
                    Text(
                        auth.tierLabel,
                        color = Color.White,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }

            SettingsDivider(theme)

            // Weekly usage row
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 16.dp)
            ) {
                Text("📊", fontSize = 14.sp)
                Spacer(Modifier.width(8.dp))
                Text("Weekly Usage", color = theme.t1, fontSize = 13.sp, fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f))
                Text(
                    auth.usageText,
                    color = if (remaining <= 10 && !auth.isUnlimited) Color(0xFFF97316) else theme.accent,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold
                )
            }

            // Upgrade + restore for free users
            if (tier == "free") {
                SettingsDivider(theme)
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onUpgrade() }
                        .padding(horizontal = 16.dp, vertical = 16.dp)
                ) {
                    Text("⬆", fontSize = 14.sp, color = theme.accent)
                    Spacer(Modifier.width(8.dp))
                    Text("Upgrade to Pro", color = theme.accent, fontSize = 13.sp,
                        fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    Text("›", color = theme.t3, fontSize = 16.sp)
                }

                SettingsDivider(theme)
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { auth.verifyLicense() }
                        .padding(horizontal = 16.dp, vertical = 16.dp)
                ) {
                    Text("↺", fontSize = 14.sp, color = theme.t2)
                    Spacer(Modifier.width(8.dp))
                    Text("Restore Purchases", color = theme.t2, fontSize = 13.sp,
                        modifier = Modifier.weight(1f))
                }
            }

            SettingsDivider(theme)

            // Terms & Privacy — inline row
            Row(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                TextButton(
                    onClick = { context.startActivity(Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://www.apple.com/legal/internet-services/itunes/dev/stdeula/"))) },
                    contentPadding = PaddingValues(0.dp)
                ) {
                    Text("Terms of Use", color = theme.t3, fontSize = 11.sp)
                }
                TextButton(
                    onClick = { context.startActivity(Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://www.pruneai.com/privacy"))) },
                    contentPadding = PaddingValues(0.dp)
                ) {
                    Text("Privacy Policy", color = theme.t3, fontSize = 11.sp)
                }
            }

            SettingsDivider(theme)

            // Sign Out
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 16.dp)
            ) {
                Text("↩", fontSize = 14.sp, color = Color.Red)
                Spacer(Modifier.width(8.dp))
                TextButton(
                    onClick = { auth.signOut() },
                    contentPadding = PaddingValues(0.dp)
                ) {
                    Text("Sign Out", color = Color.Red, fontSize = 13.sp)
                }
            }

            SettingsDivider(theme)

            // Delete Account
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 16.dp)
            ) {
                Text("🗑", fontSize = 14.sp)
                Spacer(Modifier.width(8.dp))
                TextButton(
                    onClick = { showDeleteDialog = true },
                    contentPadding = PaddingValues(0.dp)
                ) {
                    Text("Delete Account", color = Color.Red.copy(alpha = 0.7f), fontSize = 13.sp)
                }
            }
        }

        Spacer(Modifier.height(24.dp))

        // ── MODE ──
        Column(modifier = Modifier.padding(horizontal = 20.dp)) {
            SectionLabel("MODE", theme)
            Spacer(Modifier.height(10.dp))
            ModeToggle(
                selected = aggressiveness.name.lowercase(),
                onSelect = { mode ->
                    settings.setAggressiveness(AggressivenessMode.values().first { it.name.lowercase() == mode })
                },
                theme = theme,
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(6.dp))
            Text(aggressiveness.description, color = theme.t3, fontSize = 11.sp)
        }

        Spacer(Modifier.height(24.dp))

        // ── OPTIMIZATION FEATURES ──
        SectionBlock(theme, "OPTIMIZATION FEATURES") {
            val removeFillerWords by settings.removeFillerWords.collectAsState()
            val removePoliteness by settings.removePoliteness.collectAsState()
            val removeHedging by settings.removeHedging.collectAsState()
            val removeMetaLanguage by settings.removeMetaLanguage.collectAsState()
            val shortenPhrases by settings.shortenPhrases.collectAsState()
            val simplifyInstructions by settings.simplifyInstructions.collectAsState()
            val removeRedundancy by settings.removeRedundancy.collectAsState()
            val compressWhitespace by settings.compressWhitespace.collectAsState()
            val compressCodeBlocks by settings.compressCodeBlocks.collectAsState()

            val toggles = listOf(
                "Remove filler words" to Pair(removeFillerWords, { settings.setRemoveFillerWords(!removeFillerWords) }),
                "Remove politeness" to Pair(removePoliteness, { settings.setRemovePoliteness(!removePoliteness) }),
                "Remove hedging" to Pair(removeHedging, { settings.setRemoveHedging(!removeHedging) }),
                "Remove meta-language" to Pair(removeMetaLanguage, { settings.setRemoveMetaLanguage(!removeMetaLanguage) }),
                "Shorten phrases" to Pair(shortenPhrases, { settings.setShortenPhrases(!shortenPhrases) }),
                "Simplify vocabulary" to Pair(simplifyInstructions, { settings.setSimplifyInstructions(!simplifyInstructions) }),
                "Remove redundancy" to Pair(removeRedundancy, { settings.setRemoveRedundancy(!removeRedundancy) }),
                "Compress whitespace" to Pair(compressWhitespace, { settings.setCompressWhitespace(!compressWhitespace) }),
                "Compress code" to Pair(compressCodeBlocks, { settings.setCompressCodeBlocks(!compressCodeBlocks) })
            )

            toggles.forEachIndexed { i, (label, pair) ->
                val (value, action) = pair
                Toggle(label, value, action, theme)
                if (i < toggles.size - 1) SettingsDivider(theme)
            }
        }

        Spacer(Modifier.height(24.dp))

        // ── THEME ──
        Column(modifier = Modifier.padding(horizontal = 20.dp)) {
            SectionLabel("THEME", theme)
            Spacer(Modifier.height(10.dp))
            ThemePicker(selected = themeName, onSelect = { settings.setTheme(it) }, theme = theme)
        }

        // Version
        Text(
            "Terse v1.0",
            color = theme.t3.copy(alpha = 0.5f),
            fontSize = 10.sp,
            modifier = Modifier
                .align(Alignment.CenterHorizontally)
                .padding(top = 16.dp)
        )

        Spacer(Modifier.height(40.dp))
    }
}

// Card block with section label above — matches iOS section style
@Composable
private fun SectionBlock(
    theme: com.pruneai.terse.core.TerseTheme,
    label: String,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(modifier = Modifier.padding(horizontal = 20.dp)) {
        SectionLabel(label, theme)
        Spacer(Modifier.height(10.dp))
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(theme.surface),
            content = content
        )
    }
}

@Composable
private fun SettingsDivider(theme: com.pruneai.terse.core.TerseTheme) {
    HorizontalDivider(color = theme.border, thickness = 0.5.dp)
}

@Composable
private fun Toggle(
    label: String,
    value: Boolean,
    onToggle: () -> Unit,
    theme: com.pruneai.terse.core.TerseTheme
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, color = theme.t1, fontSize = 13.sp, fontWeight = FontWeight.Medium,
            modifier = Modifier.weight(1f))
        Switch(
            checked = value,
            onCheckedChange = { onToggle() },
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = theme.accent,
                uncheckedTrackColor = theme.border
            )
        )
    }
}
