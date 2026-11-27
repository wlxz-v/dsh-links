package dev.deeplinks.native

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import dev.deeplinks.core.Dsh
import dev.deeplinks.core.DshS
import dev.deeplinks.core.DshType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private const val HOLD_TO_APPROVE_MS = 1500

@Composable
internal fun HighRiskWarningNote(reason: String?) {
    val s = DshS
    val label = if (reason.isNullOrBlank()) s.translation("highRiskWarning") else "${s.translation("highRiskWarning")} ($reason)"
    Text(
        text = label,
        style = DshType.supporting,
        color = Dsh.err,
        modifier = Modifier
            .fillMaxWidth()
            .background(Dsh.err.copy(alpha = 0.1f), RoundedCornerShape(DshRadius.control))
            .padding(horizontal = DshSpace.s12, vertical = DshSpace.s8),
    )
}

@Composable
internal fun HoldToApproveButton(
    enabled: Boolean,
    onConfirmed: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val s = DshS
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val progress = remember { Animatable(0f) }
    var holding by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(DshRadius.container)
    Box(
        modifier = modifier
            .height(DshRowHeight.default)
            .clip(shape)
            .background(if (enabled) Dsh.err.copy(alpha = 0.16f) else Dsh.surface2)
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    holding = true
                    val animJob = scope.launch {
                        try {
                            progress.snapTo(0f)
                            progress.animateTo(
                                targetValue = 1f,
                                animationSpec = tween(durationMillis = HOLD_TO_APPROVE_MS, easing = LinearEasing),
                            )
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            onConfirmed()
                        } catch (_: CancellationException) {
                        }
                    }
                    waitForUpOrCancellation()
                    holding = false
                    animJob.cancel()
                    scope.launch { progress.snapTo(0f) }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (progress.value > 0f) {
            Box(
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .fillMaxWidth(progress.value)
                    .fillMaxHeight()
                    .background(Dsh.err),
            )
        }
        Text(
            text = if (holding) s.translation("holdToApproveProgress") else s.translation("holdToApprove"),
            style = DshType.bodyStrong,
            color = if (progress.value > 0.55f) Dsh.onBrand else if (enabled) Dsh.err else Dsh.tertiaryText,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = DshSpace.s12),
        )
    }
}
