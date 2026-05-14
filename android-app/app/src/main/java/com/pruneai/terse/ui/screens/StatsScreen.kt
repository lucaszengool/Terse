package com.pruneai.terse.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pruneai.terse.R
import com.pruneai.terse.core.TerseSettings
import com.pruneai.terse.core.TerseThemes
import com.pruneai.terse.ui.components.AppBackground
import com.pruneai.terse.ui.components.GlassCard
import com.pruneai.terse.ui.components.SectionLabel
import java.util.*

@Composable
fun StatsScreen() {
    val context = LocalContext.current
    val settings = remember { TerseSettings.getInstance(context) }

    val themeName by settings.theme.collectAsState()
    val theme = TerseThemes.get(themeName)
    val totalOptimizations by settings.totalOptimizations.collectAsState()
    val totalTokensSaved by settings.totalTokensSaved.collectAsState()
    val totalTokensOptimized by settings.totalTokensOptimized.collectAsState()

    val entries = remember { settings.getStatsEntries() }
    val now = System.currentTimeMillis() / 86400000L
    val weekStart = now - Calendar.getInstance().get(Calendar.DAY_OF_WEEK) + 1
    val monthStart = now - Calendar.getInstance().get(Calendar.DAY_OF_MONTH) + 1

    fun filterEntries(from: Long) = entries.filter {
        (it["date"] as? Long ?: 0L) >= from
    }

    fun sumTokensSaved(list: List<Map<String, Any>>) =
        list.sumOf { it["tokensSaved"] as? Int ?: 0 }

    fun sumOptimizations(list: List<Map<String, Any>>) = list.size

    val periods = listOf(
        "Today" to now,
        "This Week" to weekStart,
        "This Month" to monthStart,
        "All Time" to 0L
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            "Your Stats",
            color = theme.t1,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(vertical = 8.dp)
        )

        if (totalOptimizations == 0) {
            Box(
                modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    "No optimizations yet.\nStart optimizing prompts to see your stats!",
                    color = theme.t3,
                    fontSize = 15.sp,
                    textAlign = TextAlign.Center,
                    lineHeight = 24.sp
                )
            }
        } else {
            // All-time hero stats
            GlassCard(theme, modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    StatItem("$totalOptimizations", "Optimizations", theme)
                    StatItem("$totalTokensSaved", "Tokens Saved", theme)
                    val avg = if (totalTokensOptimized > 0)
                        "${(totalTokensSaved * 100 / totalTokensOptimized)}%" else "—"
                    StatItem(avg, "Avg Savings", theme)
                }
            }

            // Period breakdown
            periods.forEach { (label, fromDay) ->
                val filtered = if (fromDay == 0L) entries else filterEntries(fromDay)
                val saved = sumTokensSaved(filtered)
                val count = sumOptimizations(filtered)
                if (count > 0 || fromDay == 0L) {
                    SectionLabel(label, theme)
                    GlassCard(theme, modifier = Modifier.fillMaxWidth()) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceEvenly
                        ) {
                            StatItem("$count", "Optimizations", theme)
                            StatItem("$saved", "Tokens Saved", theme)
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(80.dp))
    }
}

@Composable
private fun StatItem(value: String, label: String, theme: com.pruneai.terse.core.TerseTheme) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = theme.t1, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text(label, color = theme.t3, fontSize = 12.sp)
    }
}
