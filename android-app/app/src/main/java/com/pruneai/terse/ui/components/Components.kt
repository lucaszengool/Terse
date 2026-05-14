package com.pruneai.terse.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pruneai.terse.core.TerseTheme

// Card with surface background + 0.5dp border — matches iOS sf/border style
@Composable
fun GlassCard(
    theme: TerseTheme,
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 16.dp,
    padding: Dp = 0.dp,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(cornerRadius))
            .background(theme.surface)
            .border(0.5.dp, theme.border, RoundedCornerShape(cornerRadius))
            .then(if (padding > 0.dp) Modifier.padding(padding) else Modifier),
        content = content
    )
}

// Full-width primary action button — accent background, white text, rounded corners
@Composable
fun TerseButton(
    text: String,
    onClick: () -> Unit,
    theme: TerseTheme,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(
            containerColor = theme.accent,
            contentColor = Color.White,
            disabledContainerColor = theme.accent.copy(alpha = 0.4f),
            disabledContentColor = Color.White.copy(alpha = 0.4f)
        ),
        shape = RoundedCornerShape(16.dp),
        modifier = modifier.height(52.dp),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 15.dp)
    ) {
        Text(text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
    }
}

// Underline-style mode selector — matches iOS: text + 2dp accent line below selected
@Composable
fun ModeToggle(
    selected: String,
    onSelect: (String) -> Unit,
    theme: TerseTheme,
    modifier: Modifier = Modifier
) {
    val modes = listOf("light" to "Light", "balanced" to "Balanced", "aggressive" to "Aggressive")
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.Bottom
    ) {
        modes.forEach { (key, label) ->
            val isSelected = selected == key
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier
                    .wrapContentWidth()
                    .clickable(indication = null, interactionSource = null) { onSelect(key) }
                    .padding(end = 20.dp)
            ) {
                Text(
                    text = label,
                    color = if (isSelected) theme.t1 else theme.t3,
                    fontSize = 13.sp,
                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium
                )
                Spacer(Modifier.height(4.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(2.dp)
                        .background(if (isSelected) theme.accent else Color.Transparent)
                )
            }
        }
        Spacer(Modifier.weight(1f))
    }
}

// Theme picker circles grid
@Composable
fun ThemePicker(
    selected: com.pruneai.terse.core.TerseThemeName,
    onSelect: (com.pruneai.terse.core.TerseThemeName) -> Unit,
    theme: TerseTheme
) {
    val solidThemes = com.pruneai.terse.core.TerseThemes.solidThemes
    val gradientThemes = com.pruneai.terse.core.TerseThemes.gradientThemes

    Column {
        Text("Solid", color = theme.t3, fontSize = 11.sp, fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(bottom = 8.dp))
        ThemeGrid(solidThemes, selected, onSelect)
        Spacer(Modifier.height(12.dp))
        Text("Gradient", color = theme.t3, fontSize = 11.sp, fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(bottom = 8.dp))
        ThemeGrid(gradientThemes, selected, onSelect)
    }
}

@Composable
private fun ThemeGrid(
    themes: List<com.pruneai.terse.core.TerseThemeName>,
    selected: com.pruneai.terse.core.TerseThemeName,
    onSelect: (com.pruneai.terse.core.TerseThemeName) -> Unit
) {
    themes.chunked(5).forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(bottom = 8.dp)) {
            row.forEach { name ->
                val t = com.pruneai.terse.core.TerseThemes.get(name)
                val isSelected = name == selected
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(44.dp)
                        .clip(CircleShape)
                        .then(
                            if (t.isGradient && t.bgGradient != null)
                                Modifier.background(Brush.linearGradient(t.bgGradient))
                            else
                                Modifier.background(t.bg)
                        )
                        .border(
                            width = if (isSelected) 2.dp else 1.dp,
                            color = if (isSelected) Color.Black.copy(alpha = 0.6f)
                                    else Color.Black.copy(alpha = 0.12f),
                            shape = CircleShape
                        )
                        .clickable { onSelect(name) }
                ) {
                    if (isSelected) {
                        Text("✓", color = t.t1, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

// Solid or gradient background fill
@Composable
fun AppBackground(
    theme: TerseTheme,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .then(
                if (theme.isGradient && theme.bgGradient != null)
                    Modifier.background(Brush.verticalGradient(theme.bgGradient))
                else
                    Modifier.background(theme.bg)
            )
    ) {
        content()
    }
}

// ACCOUNT label / THEME label etc — all-caps, small, t3
@Composable
fun SectionLabel(text: String, theme: TerseTheme) {
    Text(
        text = text,
        color = theme.t3,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.5.sp,
        modifier = Modifier.padding(horizontal = 0.dp, vertical = 4.dp)
    )
}
