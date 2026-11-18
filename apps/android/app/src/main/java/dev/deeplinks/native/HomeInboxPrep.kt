package dev.deeplinks.native

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import dev.deeplinks.core.DshS
import dev.deeplinks.core.homeAnswer
import dev.deeplinks.native.ui.v4.DlAction
import dev.deeplinks.native.ui.v4.DlButtonStyle
import dev.deeplinks.native.ui.v4.DlInboxItem
import dev.deeplinks.native.util.HomeSection
import dev.deeplinks.native.util.HomeTimeClock
import dev.deeplinks.native.util.homeSearchGroups
import dev.deeplinks.native.util.homeSections

/**
 * 首页收件箱与搜索列表的数据预计算层：
 * 把子智能体计数聚合、分组排序、标题清理、相对时间格式化全部收敛到数据变更时一次性完成，
 * 让 LazyColumn 在高速滑动期间只做轻量布局与文本绘制（零全表扫描、零时区锁、零正则/格式化分配）。
 */
@Immutable
internal data class PreparedHomeRow(
    val session: MobileSession,
    val title: String,
    val time: String,
    val baseTexts: HomeInboxTexts,
    val showDivider: Boolean,
)

@Immutable
internal data class PreparedHomeSection(
    val section: HomeSection,
    val rows: List<PreparedHomeRow>,
)

@Immutable
internal data class PreparedSearchRow(
    val sessionId: String,
    val workspace: String,
    val time: String,
    val title: String,
    val preview: String?,
    val showDivider: Boolean,
)

@Immutable
internal data class PreparedSearchGroups(
    val titleMatches: List<PreparedSearchRow>,
    val contentMatches: List<PreparedSearchRow>,
) {
    val isEmpty: Boolean get() = titleMatches.isEmpty() && contentMatches.isEmpty()
}

internal fun prepareHomeSections(
    scoped: List<MobileSession>,
    allSessions: List<MobileSession>,
    goalSummaries: Map<String, String>,
    online: Boolean,
    nowMillis: Long = System.currentTimeMillis(),
): List<PreparedHomeSection> {
    if (scoped.isEmpty()) return emptyList()
    val subagentCounts = runningSubagentCountsByParent(allSessions)
    val clock = HomeTimeClock(now = nowMillis)
    val offline = !online
    return homeSections(scoped).map { (section, rows) ->
        val preparedRows = ArrayList<PreparedHomeRow>(rows.size)
        rows.forEachIndexed { index, raw ->
            val subCount = subagentCounts[raw.sessionId]?.takeIf { it > 0 }
            val session = if (raw.subagentCount == subCount) raw else raw.copy(subagentCount = subCount)
            preparedRows += PreparedHomeRow(
                session = session,
                title = displaySessionTitle(session.title),
                time = if (session.updatedAt > 0) clock.format(session.updatedAt) else "",
                baseTexts = homeInboxTexts(
                    session = session,
                    pending = null,
                    goalSummary = goalSummaries[session.sessionId],
                    offline = offline,
                ),
                showDivider = index > 0,
            )
        }
        PreparedHomeSection(section = section, rows = preparedRows)
    }
}

internal fun prepareHomeSearchGroups(
    scoped: List<MobileSession>,
    needle: String,
    searchResults: List<MobileSearchResult>,
    nowMillis: Long = System.currentTimeMillis(),
): PreparedSearchGroups {
    if (scoped.isEmpty()) return PreparedSearchGroups(emptyList(), emptyList())
    val snippets = if (searchResults.isEmpty()) {
        emptyMap()
    } else {
        HashMap<String, String>(searchResults.size).apply {
            for (r in searchResults) put(r.sessionId, r.snippet)
        }
    }
    val raw = homeSearchGroups(scoped, needle, snippets)
    val clock = HomeTimeClock(now = nowMillis)
    val titles = raw.titleMatches.mapIndexed { index, s ->
        PreparedSearchRow(
            sessionId = s.sessionId,
            workspace = homeWorkspaceName(s).orEmpty(),
            time = if (s.updatedAt > 0) clock.format(s.updatedAt) else "",
            title = displaySessionTitle(s.title),
            preview = null,
            showDivider = index > 0,
        )
    }
    val contents = raw.contentMatches.mapIndexed { index, (s, snippet) ->
        PreparedSearchRow(
            sessionId = s.sessionId,
            workspace = homeWorkspaceName(s).orEmpty(),
            time = if (s.updatedAt > 0) clock.format(s.updatedAt) else "",
            title = displaySessionTitle(s.title),
            preview = snippet?.let { "…$it…" },
            showDivider = index > 0,
        )
    }
    return PreparedSearchGroups(titles, contents)
}

@Composable
internal fun PreparedHomeInboxItem(
    row: PreparedHomeRow,
    pending: MobileMessage?,
    online: Boolean,
    goalSummary: String?,
    onSelectSession: (String) -> Unit,
    onLongPress: (MobileSession) -> Unit,
    onAnswerApproval: (String, String, (Boolean) -> Unit) -> Unit,
) {
    val s = DshS
    val currentSelect by rememberUpdatedState(onSelectSession)
    val currentLongPress by rememberUpdatedState(onLongPress)
    val currentAnswer by rememberUpdatedState(onAnswerApproval)
    val sessionId = row.session.sessionId
    val onClick = remember(sessionId) { { currentSelect(sessionId) } }
    val onLongClick = remember(row.session) { { currentLongPress(row.session) } }
    val texts = if (pending == null) {
        row.baseTexts
    } else {
        remember(row.session, pending, goalSummary, online, s) {
            homeInboxTexts(row.session, pending, goalSummary, offline = !online)
        }
    }
    val actions = when (texts.pending) {
        HomePendingKind.Approval -> {
            val approvalId = pending?.approvalId
            remember(approvalId, online, s) {
                listOf(
                    DlAction(s.reject, onClick = { approvalId?.let { currentAnswer(it, "rejected") {} } }),
                    DlAction(
                        s.allowOnce,
                        onClick = { approvalId?.let { currentAnswer(it, "allowed-once") {} } },
                        style = DlButtonStyle.Filled,
                        enabled = online,
                    ),
                )
            }
        }
        HomePendingKind.Question -> remember(onClick, s) {
            listOf(DlAction(s.homeAnswer, onClick))
        }
        HomePendingKind.None -> emptyList()
    }
    Column {
        if (row.showDivider) HomeDivider()
        DlInboxItem(
            workspace = texts.workspace,
            time = row.time,
            title = row.title,
            status = texts.status,
            tone = texts.tone,
            preview = texts.preview,
            command = texts.command,
            running = texts.running,
            actions = actions,
            onClick = onClick,
            onLongClick = onLongClick,
        )
    }
}

@Composable
internal fun PreparedHomeSearchItem(
    row: PreparedSearchRow,
    needle: String,
    onSelectSession: (String) -> Unit,
) {
    val currentSelect by rememberUpdatedState(onSelectSession)
    val onClick = remember(row.sessionId) { { currentSelect(row.sessionId) } }
    Column {
        if (row.showDivider) HomeDivider()
        DlInboxItem(
            workspace = row.workspace,
            time = row.time,
            title = row.title,
            preview = row.preview,
            highlight = needle,
            onClick = onClick,
        )
    }
}

/** 把每轮重组新建的回调集合收敛为稳定引用，避免父容器局部状态变化连带重绘首页侧栏。 */
@Composable
internal fun rememberStableSidebarActions(latest: WorkspaceSidebarActions): WorkspaceSidebarActions {
    val ref by rememberUpdatedState(latest)
    return remember {
        WorkspaceSidebarActions(
            onOpenDevice = { ref.onOpenDevice() },
            onNewSession = { ref.onNewSession() },
            onSelectSession = { ref.onSelectSession(it) },
            onRenameSession = { ref.onRenameSession(it) },
            onArchiveSession = { ref.onArchiveSession(it) },
            onDeleteSession = { ref.onDeleteSession(it) },
            onForkSession = { ref.onForkSession(it) },
            onCreateSessionIn = { ref.onCreateSessionIn(it) },
            onDeleteWorkspace = { ref.onDeleteWorkspace(it) },
            onToggleSearch = { ref.onToggleSearch() },
            onSearchQueryChange = { ref.onSearchQueryChange(it) },
            onClearSearch = { ref.onClearSearch() },
            onRetrySearch = { ref.onRetrySearch() },
            onRetrySessions = { ref.onRetrySessions() },
            onAddWorkspace = { ref.onAddWorkspace() },
            onOpenSettings = { ref.onOpenSettings() },
            onShareSession = { ref.onShareSession(it) },
        )
    }
}
