package com.pruneai.terse.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
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
import com.pruneai.terse.core.TerseThemes
import com.pruneai.terse.core.TerseThemeName
import com.pruneai.terse.ui.components.AppBackground

@Composable
fun SignInScreen() {
    val context = LocalContext.current
    val auth = remember { TerseAuth.getInstance(context) }
    val theme = TerseThemes.get(TerseThemeName.CREAM)
    val signInError by auth.signInError.collectAsState()
    var isLoading by remember { mutableStateOf(false) }

    val browserLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { auth.checkPendingAuth() }

    LaunchedEffect(Unit) { auth.checkPendingAuth() }

    AppBackground(theme) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(Modifier.weight(1f))

            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(64.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(theme.accent)
            ) {
                Text("T", color = Color.White, fontSize = 32.sp, fontWeight = FontWeight.Bold)
            }

            Spacer(Modifier.height(20.dp))

            Text(
                "Terse",
                color = theme.t1,
                fontSize = 34.sp,
                fontWeight = FontWeight.Bold
            )

            Text(
                "Smart prompt compression",
                color = theme.t3,
                fontSize = 15.sp,
                modifier = Modifier.padding(bottom = 48.dp)
            )

            Column(
                verticalArrangement = Arrangement.spacedBy(20.dp),
                modifier = Modifier.padding(bottom = 48.dp)
            ) {
                FeatureRow("⚡", "Save up to 70%", "on every AI prompt", theme)
                FeatureRow("🌐", "11 languages", "works everywhere you type", theme)
                FeatureRow("🔒", "100% on-device", "your words never leave", theme)
            }

            Button(
                onClick = {
                    isLoading = true
                    auth.startWebSignIn(
                        onUrl = { url ->
                            isLoading = false
                            browserLauncher.launch(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        },
                        onError = { isLoading = false }
                    )
                },
                enabled = !isLoading,
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color.Black,
                    contentColor = Color.White
                ),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth().height(52.dp)
            ) {
                if (isLoading) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), color = Color.White)
                } else {
                    Text("Sign in with Google", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                }
            }

            if (signInError != null) {
                Text(
                    signInError!!,
                    color = Color.Red,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(top = 12.dp)
                )
            }

            Text(
                "500 free optimizations per week",
                color = theme.t3,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 16.dp)
            )

            Spacer(Modifier.weight(2f))
        }
    }
}

@Composable
private fun FeatureRow(icon: String, title: String, detail: String, theme: com.pruneai.terse.core.TerseTheme) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(32.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(theme.accent.copy(alpha = 0.1f))
        ) {
            Text(icon, fontSize = 14.sp)
        }
        Column {
            Text(title, color = theme.t1, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text(detail, color = theme.t3, fontSize = 13.sp)
        }
    }
}
