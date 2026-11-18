package dev.deeplinks.native

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.Dp
import dev.deeplinks.core.DshLayout
import dev.deeplinks.core.deriveDshLayout
import dev.deeplinks.native.util.isChatVisible

/**
 * WorkspaceScreen 的布局派生（第三轮 S6 抽出）。
 *
 * 用实际窗口容器宽度而不是设备屏幕宽度：分屏、自由窗口、折叠屏下 `screenWidthDp` 会失真。
 * 另外给出 [chatVisible]（常驻侧栏视为始终可见），首页阶段据此决定要不要为当前会话预加载。
 */
internal data class WorkspaceChrome(
    val layout: DshLayout,
    val containerWidthDp: Dp,
    val displayDest: String,
    val showSessionHome: Boolean,
    val chatVisible: Boolean,
)

@Composable
internal fun rememberWorkspaceChrome(
    phoneDest: String,
    currentSessionId: String?,
    composeNewSession: Boolean,
    chatDest: String,
    sessionsDest: String,
    onCollapseToChat: () -> Unit,
): WorkspaceChrome {
    val windowInfo = LocalWindowInfo.current
    val density = LocalDensity.current
    val containerWidthDp = with(density) { windowInfo.containerSize.width.toDp() }
    val containerHeightDp = with(density) { windowInfo.containerSize.height.toDp() }
    val layout = remember(containerWidthDp, containerHeightDp) {
        deriveDshLayout(containerWidthDp.value.toInt(), containerHeightDp.value.toInt())
    }
    var prevPersistent by remember { mutableStateOf(layout.persistentSidebar) }
    val collapsingToPhone = prevPersistent && !layout.persistentSidebar
    val displayDest = when {
        layout.persistentSidebar -> chatDest
        collapsingToPhone && (currentSessionId != null || composeNewSession) -> chatDest
        else -> phoneDest
    }
    SideEffect {
        if (collapsingToPhone && (currentSessionId != null || composeNewSession)) onCollapseToChat()
        prevPersistent = layout.persistentSidebar
    }
    return WorkspaceChrome(
        layout = layout,
        containerWidthDp = containerWidthDp,
        displayDest = displayDest,
        showSessionHome = !layout.persistentSidebar && displayDest == sessionsDest,
        chatVisible = isChatVisible(layout.persistentSidebar, displayDest, chatDest),
    )
}

/**
 * 执行中读秒状态隔离器：每秒递增只唤醒真正展示秒数的叶子节点（[ThinkingStatusRow]），
 * 顶栏副标题只按分钟分桶订阅 [subtitleBucket]，避免整棵 WorkspaceScreen 与 LazyColumn 每秒重组。
 */
@Stable
internal class TurnElapsedTimer {
    var seconds by mutableLongStateOf(0L)
    val subtitleBucket: Long by derivedStateOf {
        val s = seconds
        if (s <= 0L) 0L else (s / 60L).coerceAtLeast(1L) * 60L
    }
}

@Composable
internal fun rememberTurnElapsedTimer(running: Boolean): TurnElapsedTimer {
    val timer = remember { TurnElapsedTimer() }
    LaunchedEffect(running) {
        if (!running) {
            timer.seconds = 0L
            return@LaunchedEffect
        }
        val startMs = System.currentTimeMillis()
        while (true) {
            delay(1000)
            timer.seconds = (System.currentTimeMillis() - startMs) / 1000L
        }
    }
    return timer
}
