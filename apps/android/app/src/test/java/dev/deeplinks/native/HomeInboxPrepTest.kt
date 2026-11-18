package dev.deeplinks.native

import dev.deeplinks.core.L
import dev.deeplinks.core.subagentRunning
import dev.deeplinks.native.util.HomeSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class HomeInboxPrepTest {

    private fun mainRoot(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null && !File(dir, "src/main/java").isDirectory) dir = dir.parentFile
        return File(requireNotNull(dir), "src/main/java")
    }

    private fun session(
        id: String,
        title: String = id,
        updatedAt: Long = 1_000_000L,
        running: Boolean = false,
        awaiting: Boolean = false,
        cwd: String? = "/Users/me/dsh-links",
        origin: String? = null,
        parent: String? = null,
    ) = MobileSession(
        sessionId = id,
        title = title,
        updatedAt = updatedAt,
        running = running,
        blank = false,
        cwd = cwd,
        agentPreset = null,
        origin = origin,
        parentSessionId = parent,
        awaitingInput = awaiting,
    )

    @Test
    fun prepareHomeSectionsPrecomputesSubagentsTitlesDividersAndOrder() {
        val now = 2_000_000L
        val scoped = listOf(
            session("r1", title = "@/Users/me/dsh-links/README.md 梳理", updatedAt = now - 30_000L),
            session("r2", title = "第二条最近", updatedAt = now - 90_000L),
            session("run1", title = "执行任务", updatedAt = now - 10_000L, running = true),
        )
        val all = scoped + listOf(
            session("sub1", origin = "subagent", parent = "run1", running = true),
            session("sub2", origin = "subagent", parent = "sub1", running = true),
        )
        val sections = prepareHomeSections(
            scoped = scoped,
            allSessions = all,
            goalSummaries = mapOf("run1" to "优化滑动"),
            online = true,
            nowMillis = now,
        )
        assertEquals(listOf(HomeSection.RUNNING, HomeSection.RECENT), sections.map { it.section })
        val runningRow = sections[0].rows.single()
        assertFalse(runningRow.showDivider)
        assertEquals(2, runningRow.session.subagentCount)
        assertTrue(runningRow.baseTexts.workspace.contains(L.subagentRunning.format(2)))
        assertEquals("优化滑动", runningRow.baseTexts.preview)

        val recentRows = sections[1].rows
        assertEquals(2, recentRows.size)
        assertFalse(recentRows[0].showDivider)
        assertTrue(recentRows[1].showDivider)
        assertEquals("README.md 梳理", recentRows[0].title)
    }

    @Test
    fun prepareHomeSearchGroupsFormatsSnippetsAndDividers() {
        val now = 2_000_000L
        val scoped = listOf(
            session("s1", title = "审批流改造", updatedAt = now - 20_000L),
            session("s2", title = "构建脚本", updatedAt = now - 80_000L),
        )
        val groups = prepareHomeSearchGroups(
            scoped = scoped,
            needle = "审批",
            searchResults = listOf(MobileSearchResult("s2", "这里处理审批回调")),
            nowMillis = now,
        )
        assertEquals(1, groups.titleMatches.size)
        assertEquals("s1", groups.titleMatches[0].sessionId)
        assertEquals(null, groups.titleMatches[0].preview)
        assertEquals(1, groups.contentMatches.size)
        assertEquals("…这里处理审批回调…", groups.contentMatches[0].preview)
    }

    @Test
    fun homeAndSearchLazyColumnsUseBatchedItemsWithExplicitContentType() {
        val sidebar = mainRoot().resolve("dev/deeplinks/native/WorkspaceSidebar.kt").readText()
        assertTrue(sidebar.contains("contentType = { \"home-inbox-row\" }"))
        assertFalse("首页会话行不应无条件包 animateItem()", sidebar.contains("animateItem("))

        val hub = mainRoot().resolve("dev/deeplinks/native/HomeHub.kt").readText()
        assertTrue(hub.contains("contentType = { \"search-row\" }"))
    }

    @Test
    fun chatRowContentTypeSeparatesRolesForSlotReuse() {
        val user = MobileMessage(id = "u1", role = "user", text = "hi")
        val assistant = MobileMessage(id = "a1", role = "assistant", text = "hello")
        val prepared = prepareChatFeed(
            listOf(
                dev.deeplinks.native.util.MessageGroup.Single(user),
                dev.deeplinks.native.util.MessageGroup.Single(assistant),
            ),
        )
        assertEquals(listOf("single-user", "single-assistant"), prepared.rows.map(::chatRowContentType))
    }
}
