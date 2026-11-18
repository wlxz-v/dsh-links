package dev.deeplinks.native
import dev.deeplinks.native.util.optStringOrEmpty
import dev.deeplinks.core.DshStrings
import dev.deeplinks.core.BoundedIo
import dev.deeplinks.core.Host
import dev.deeplinks.core.HostCapabilitiesCache
import dev.deeplinks.core.HostHttp
import dev.deeplinks.core.JsonHttpCache
import dev.deeplinks.core.conditionalJsonGet
import dev.deeplinks.core.parseMissingHostRemotes
import dev.deeplinks.core.L
import dev.deeplinks.core.fileIntegrityFailed
import dev.deeplinks.core.PinnedSsl
import dev.deeplinks.core.applyBootstrapRemote
import dev.deeplinks.core.remote.RouteConnectException
import dev.deeplinks.core.remote.RouteOfflineException
import dev.deeplinks.core.remote.RouteOpenTimeoutException
import dev.deeplinks.core.remote.RouteRateLimitedException
import dev.deeplinks.core.remote.RouteRejectedException
import dev.deeplinks.core.remote.RouteServerBusyException
import dev.deeplinks.core.remote.RouteUnreachableException
import dev.deeplinks.native.MobileSession
import dev.deeplinks.native.MobileMessage
import dev.deeplinks.native.AppSettings
import dev.deeplinks.native.MobileApiClient

import android.util.Log
import org.json.JSONObject
import dev.deeplinks.native.util.optNullableString
import dev.deeplinks.native.util.parseStoppedReason
import dev.deeplinks.native.util.presentOrNull
import dev.deeplinks.native.util.redactRequestPath

class MobileApiClient(private val host: Host) {

    @Volatile
    private var cachedSessionsSnapshot: Pair<String, MobileSessionSnapshot>? = null

    @Volatile
    private var cachedWorkspacesCatalog: Pair<String, MobileWorkspaceCatalog>? = null

    /** 会话模型目录（当前模型 + 供应商分组模型列表）。 */
    fun getModels(sessionId: String): MobileModelCatalog {
        val root = request("GET", "/dsh-link/mobile/models?sessionId=" + java.net.URLEncoder.encode(sessionId, "UTF-8"))
        val current = root.optJSONObject("current")
        val groups = parseModelGroups(root.optJSONArray("groups"))
        return MobileModelCatalog(
            // optString 会把 JSON null 读成字符串 "null"（曾在模型弹层显示成「Null」）
            currentProvider = current?.optNullableString("provider"),
            currentModel = current?.optNullableString("model"),
            currentReasoningEffort = current?.optNullableString("reasoningEffort")
                ?: current?.optNullableString("effort"),
            groups = groups,
        )
    }

    /** 响应工具审批（DSH approval：allowed-once / rejected）。 */
    fun answerApproval(sessionId: String, approvalId: String, outcome: String): Boolean {
        val root = request("POST", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/approval",
            JSONObject().put("approvalId", approvalId).put("outcome", outcome))
        return root.optBoolean("accepted", false) && root.optString("outcome", outcome) == outcome
    }

    fun getSessionRequests(sessionId: String): SessionRequestSnapshot {
        val root = request("GET", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/requests")
        return parseSessionRequestSnapshot(root)
    }

    /** 回答 ask_user_question（mux question/requested → /api/respond）。 */
    fun answerQuestion(sessionId: String, rpcId: String, answer: JSONObject): Boolean {
        val root = request(
            "POST",
            "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/question",
            JSONObject().put("rpcId", rpcId).put("answer", answer),
        )
        return root.optBoolean("accepted", false)
    }

    /** 读取会话内助手消息的赞/踩反馈。 */
    fun getMessageFeedback(sessionId: String): org.json.JSONObject =
        request("GET", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/feedback")

    /** 记录一条助手消息的赞/踩。 */
    fun putMessageFeedback(sessionId: String, messageId: String, rating: String, ifVersion: String?): org.json.JSONObject {
        val body = org.json.JSONObject().put("messageId", messageId).put("rating", rating)
        if (ifVersion != null) body.put("ifVersion", ifVersion) else body.put("ifVersion", org.json.JSONObject.NULL)
        return request("POST", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/feedback", body)
    }

    /** 取消一条助手消息的赞/踩。 */
    fun deleteMessageFeedback(sessionId: String, messageId: String, ifVersion: String): org.json.JSONObject {
        val body = org.json.JSONObject()
            .put("action", "delete")
            .put("messageId", messageId)
            .put("ifVersion", ifVersion)
        return request("POST", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/feedback", body)
    }

    /** 会话重命名。 */
    fun renameSession(sessionId: String, title: String) {
        request("POST", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/rename",
            JSONObject().put("title", title))
    }

    /** 分叉会话，返回子会话 id。 */
    fun forkSession(sessionId: String): String? {
        val root = request("POST", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/fork", JSONObject())
        return root.optNullableString("sessionId")
    }

    /** 工作区列表（含服务端已归档会话 id，用于跨设备同步隐藏）。 */
    fun getWorkspaces(): MobileWorkspaceCatalog {
        val raw = requestGetRaw("/dsh-link/mobile/workspaces")
        cachedWorkspacesCatalog?.let { (prevRaw, prevCatalog) ->
            if (prevRaw === raw || prevRaw == raw) return prevCatalog
        }
        val root = JSONObject(raw)
        val arr = root.optJSONArray("workspaces") ?: org.json.JSONArray()
        val workspaces = (0 until arr.length()).mapNotNull { i ->
            parseMobileWorkspace(arr.optJSONObject(i))
        }
        val archived = root.optJSONArray("archivedSessionIds")
        val archivedArray = archived ?: org.json.JSONArray()
        val archivedIds = (0 until archivedArray.length()).mapNotNull { i ->
            archivedArray.optString(i).takeIf { it.isNotBlank() }
        }.toSet()
        return MobileWorkspaceCatalog(
            workspaces = workspaces,
            archivedSessionIds = archivedIds,
            archiveSnapshotAvailable = archived != null,
        ).also { cachedWorkspacesCatalog = raw to it }
    }

    /** 按会话设置权限预设（对标 web 当前会话权限）。 */
    fun setSessionPermission(sessionId: String, preset: String) {
        request(
            "POST",
            "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/permission",
            JSONObject().put("preset", preset),
        )
    }

    /** 按名称创建同级工作区，或按绝对路径注册已有目录。 */
    fun createWorkspace(input: String, parentWorkspaceId: String? = null): MobileWorkspaceCreation {
        val body = JSONObject()
            .put("input", input)
            // 兼容尚未升级、只读取 path 的插件；绝对路径模式仍可继续工作。
            .put("path", input)
        if (!parentWorkspaceId.isNullOrBlank()) body.put("parentWorkspaceId", parentWorkspaceId)
        val root = request("POST", "/dsh-link/mobile/workspaces", body)
        if (root.optBoolean("pending")) {
            return MobileWorkspaceCreation(
                workspace = null,
                created = false,
                pending = true,
                path = root.optStringOrEmpty("path"),
            )
        }
        return MobileWorkspaceCreation(
            workspace = parseMobileWorkspace(root.optJSONObject("workspace"))
                ?: throw IllegalStateException(L.workspaceCreateInvalidResponse),
            created = root.optBoolean("created", false),
        )
    }

    /** 删除工作区（取消注册；会话日志保留，DSH workspace.delete 语义）。 */
    fun deleteWorkspace(path: String) {
        request("POST", "/dsh-link/mobile/workspaces/delete", JSONObject().put("path", path))
    }

    /** 删除会话（服务端归档，workspace.archiveSession 语义；对标 web 删除）。 */
    fun archiveSession(sessionId: String) {
        request("POST", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/archive", JSONObject())
    }

    /** 选择会话模型（可选推理等级，对齐 Web session.selectModel）。 */
    fun selectModel(sessionId: String, provider: String, model: String, reasoningEffort: String? = null) {
        val body = JSONObject().put("provider", provider).put("model", model)
        if (!reasoningEffort.isNullOrBlank()) body.put("reasoningEffort", reasoningEffort)
        request("POST", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/model", body)
    }

    fun bootstrap(): Pair<MobileBootstrap, Host> {
        val root = request("GET", "/dsh-link/mobile/bootstrap")
        val sessions = root.optJSONArray("sessions") ?: org.json.JSONArray()
        val archived = root.optJSONArray("archivedSessionIds")
        val archivedArray = archived ?: org.json.JSONArray()
        val info = MobileBootstrap(
            hostName = root.optJSONObject("host")?.optStringOrEmpty("name").orEmpty(),
            deviceName = root.optJSONObject("device")?.optStringOrEmpty("name").orEmpty(),
            sessions = (0 until sessions.length()).mapNotNull { index ->
                runCatching { parseMobileSession(sessions.getJSONObject(index)) }.getOrNull()
            },
            archivedSessionIds = (0 until archivedArray.length()).mapNotNull { index ->
                archivedArray.optString(index).takeIf { it.isNotBlank() }
            }.toSet(),
            archiveSnapshotAvailable = archived != null,
            protocol = root.optInt("protocol", 1),
            syncResync = root.optJSONObject("capabilities")?.optJSONObject("sync")?.optBoolean("resync") == true,
            multiQuestion = root.optJSONObject("capabilities")?.optJSONObject("questions")?.optBoolean("multi") == true,
            requestSnapshot = root.optJSONObject("capabilities")?.optJSONObject("requests")?.optBoolean("snapshot") == true,
            filesTree = root.optJSONObject("capabilities")?.optJSONObject("files")?.optBoolean("tree") == true,
            sessionControl = root.optJSONObject("capabilities")?.optJSONObject("control")?.optBoolean("queue") == true,
            preview = root.optJSONObject("capabilities")?.optJSONObject("preview")?.optInt("v") == 1,
            previewDetect = root.optJSONObject("capabilities")?.optJSONObject("preview")?.optInt("detect") == 1,
            hostMissing = parseMissingHostRemotes(root.optJSONObject("capabilities")?.optJSONObject("host")),
        )
        HostCapabilitiesCache.put(host.slotKey, info.hostMissing)
        return info to applyBootstrapRemote(host, root)
    }

    fun listPreviewDetections(sessionId: String): List<Int> {
        val root = request("GET", "/dsh-link/mobile/preview-detections")
        val array = root.optJSONArray("detections") ?: return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                if (item.optString("sessionId") != sessionId) continue
                val port = item.optInt("port")
                if (port > 0) add(port)
            }
        }
    }

    fun listPreviews(): List<MobilePreview> {
        val root = request("GET", "/dsh-link/mobile/previews")
        val array = root.optJSONArray("previews") ?: return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val id = item.optString("previewId")
                val port = item.optInt("port")
                if (id.isBlank() || port <= 0) continue
                add(MobilePreview(id, item.optString("label").ifBlank { port.toString() }, port, item.optLong("expiresAt")))
            }
        }
    }

    fun getSessions(): MobileSessionSnapshot {
        val raw = requestGetRaw("/dsh-link/mobile/sessions")
        cachedSessionsSnapshot?.let { (prevRaw, prevSnapshot) ->
            if (prevRaw === raw || prevRaw == raw) return prevSnapshot
        }
        val root = JSONObject(raw)
        val sessions = root.optJSONArray("sessions") ?: org.json.JSONArray()
        val archived = root.optJSONArray("archivedSessionIds")
        val archivedArray = archived ?: org.json.JSONArray()
        return MobileSessionSnapshot(
            sessions = (0 until sessions.length()).mapNotNull { index ->
                runCatching { parseMobileSession(sessions.getJSONObject(index)) }.getOrNull()
            },
            archivedSessionIds = (0 until archivedArray.length()).mapNotNull { index ->
                archivedArray.optString(index).takeIf { it.isNotBlank() }
            }.toSet(),
            archiveSnapshotAvailable = archived != null,
        ).also { cachedSessionsSnapshot = raw to it }
    }

    fun getSessionHistory(sessionId: String, beforeSeq: Long? = null, maxMessages: Int? = null): HistoryResult =
        parseHistoryResponse(getSessionHistoryJson(sessionId, beforeSeq, maxMessages), beforeSeq)

    /** 原始 history 响应：仓库据此落本地快照（见 SessionHistoryCache），再用 [parseHistoryResponse] 解析。 */
    fun getSessionHistoryJson(sessionId: String, beforeSeq: Long? = null, maxMessages: Int? = null): JSONObject {
        var path = "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/history"
        val query = buildList {
            beforeSeq?.let { add("beforeSeq=$it") }
            maxMessages?.let { add("maxMessages=$it") }
        }
        if (query.isNotEmpty()) path += "?" + query.joinToString("&")
        return request("GET", path)
    }

    /** 会话工作区的一层目录（[path] 为工作区内相对路径，空串为根）。 */
    fun getWorkspaceTree(sessionId: String, path: String): WorkspaceDirListing {
        val apiPath = "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") +
            "/tree?path=" + java.net.URLEncoder.encode(path, "UTF-8")
        return parseWorkspaceDirListing(request("GET", apiPath))
    }

    fun sendPrompt(sessionId: String, text: String, mode: String = "queue", images: List<Pair<String, String>> = emptyList()) {
        val body = JSONObject().apply {
            put("text", text)
            put("mode", mode)
            if (images.isNotEmpty()) {
                put("images", org.json.JSONArray().apply {
                    images.forEach { (mediaType, data) ->
                        put(JSONObject().put("mediaType", mediaType).put("data", data))
                    }
                })
            }
        }
        request("POST", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/prompt", body)
    }

    fun getSessionFile(sessionId: String, path: String): Pair<String, ByteArray> {
        if (host.token.isBlank()) throw MobileAuthException("缺少或无效的连接 token", 401)
        val encodedSid = java.net.URLEncoder.encode(sessionId, "UTF-8")
        val encodedPath = java.net.URLEncoder.encode(path, "UTF-8").replace("+", "%20")
        val apiPath = "/dsh-link/mobile/sessions/$encodedSid/file?path=$encodedPath"
        // 远程路径的超时由 HostHttp 按路由放宽；这里只给局域网的值
        val connectMs = 8_000
        val readMs = 12_000
        try {
            HostHttp.execute(
                host,
                HostHttp.DshRequest(
                    method = "GET",
                    path = apiPath,
                    headers = dshAuthHeaders() + listOf("Accept" to "*/*", "Accept-Encoding" to "identity"),
                    connectTimeoutMs = connectMs,
                    readTimeoutMs = readMs,
                ),
            ).use { response ->
                val code = response.code
                if (code !in 200..299) {
                    val text = response.body.byteStream().use { BoundedIo.readText(it) }
                    val msg = parseMobileApiError(code, text)
                    if (code == 401 || code == 403) throw MobileAuthException(msg, code)
                    throw IllegalStateException(msg)
                }
                val bytes = response.body.byteStream()
                    .use { BoundedIo.readBytes(it, BoundedIo.MAX_WORKSPACE_FILE_BYTES) }
                // 完整性：插件给了 SHA-256 就必须对上（截断 / 中途被改都拒收）；旧插件不带头则跳过
                val digest = response.header("x-dsh-link-sha256")
                if (!sha256Matches(digest, bytes)) {
                    dev.deeplinks.core.PrivacySafeDiagnostics.event(dev.deeplinks.core.PrivacySafeDiagnostics.Area.File, dev.deeplinks.core.PrivacySafeDiagnostics.Op.Verify, ok = false, count = bytes.size)
                    throw FileIntegrityException(L.fileIntegrityFailed)
                }
                val mime = response.header("Content-Type")?.substringBefore(';')?.trim().orEmpty()
                    .ifBlank { "application/octet-stream" }
                return mime to bytes
            }
        } catch (e: FileIntegrityException) {
            throw e
        } catch (e: MobileAuthException) {
            throw e
        } catch (e: Exception) {
            throw IllegalStateException(friendlyNetworkError(e), e)
        }
    }

    /**
     * 本轮改动摘要（完整文件列表）。Host 已取不到、旧插件无此路由或网络失败都返回 null：
     * 调用方只是少一张卡，下一次历史刷新会按内嵌摘要补回；鉴权失败照常抛出。
     */
    fun getWorkspaceChanges(sessionId: String, seq: Long): WorkspaceChangesSummary? {
        val sid = java.net.URLEncoder.encode(sessionId, "UTF-8")
        val root = try {
            request("GET", "/dsh-link/mobile/sessions/$sid/changes?seq=$seq")
        } catch (e: MobileAuthException) {
            throw e
        } catch (_: IllegalStateException) {
            return null
        }
        return parseWorkspaceChanges(root, seq)
    }

    /** 单个改动文件的对比（hunk 可达数千行，放宽 JSON 读取上限）。 */
    fun getWorkspaceChangeDiff(sessionId: String, seq: Long, index: Int): WorkspaceFileDiff {
        val sid = java.net.URLEncoder.encode(sessionId, "UTF-8")
        return try {
            val root = request("GET", "/dsh-link/mobile/sessions/$sid/changes/diff?seq=$seq&index=$index", maxBytes = DIFF_BODY_MAX_BYTES)
            parseWorkspaceFileDiff(root) ?: throw IllegalStateException(L.unknownError)
        } catch (e: MobileApiHttpException) {
            // 4.4：Host 已取不到这份对比（如会话被清 / 插件重启）→ 本地化提示，不透出服务端原文
            if (isChangesUnavailable(e.httpCode, e.body)) throw ChangesUnavailableException()
            throw e
        }
    }

    fun createSession(agentPreset: String? = null, cwd: String? = null, workspaceId: String? = null): String {
        val body = JSONObject()
        if (!agentPreset.isNullOrBlank()) body.put("agentPreset", agentPreset)
        // session.create 至多一个：workspaceId 才会记入 Web 分组；只传 cwd 会变成未分组。
        if (!workspaceId.isNullOrBlank()) body.put("workspaceId", workspaceId)
        else if (!cwd.isNullOrBlank()) body.put("cwd", cwd)
        val res = request("POST", "/dsh-link/mobile/sessions", body)
        return res.getString("sessionId")
    }

    fun searchSessions(query: String): Pair<List<MobileSearchResult>, Boolean> {
        val root = request("GET", "/dsh-link/mobile/sessions/search?q=" + java.net.URLEncoder.encode(query, "UTF-8"))
        val items = root.optJSONArray("items") ?: org.json.JSONArray()
        val list = (0 until items.length()).map { index ->
            val item = items.getJSONObject(index)
            MobileSearchResult(item.getString("sessionId"), item.optStringOrEmpty("snippet"))
        }
        return list to root.optBoolean("degraded", false)
    }

    // ===== 会话控制（capabilities.control）：排队消息 / 目标 / 定时任务 =====

    private fun sessionPath(sessionId: String): String =
        "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8")

    fun getSessionQueue(sessionId: String): List<QueuedPrompt> =
        parseQueueItems(request("GET", sessionPath(sessionId) + "/queue").optJSONArray("items"))

    /** [action]：edit（需 [text]）/ remove / steer。 */
    fun updateQueueItem(sessionId: String, itemId: String, action: String, text: String? = null) {
        val body = JSONObject().put("action", action)
        if (text != null) body.put("text", text)
        request("POST", sessionPath(sessionId) + "/queue/" + java.net.URLEncoder.encode(itemId, "UTF-8"), body)
    }

    /** [op]：edit / pause / resume / clear；返回新的 CAS 引用（clear 为 null）。 */
    fun goalAction(sessionId: String, op: String, ref: SessionGoalRef, objective: String? = null, maxGoalRounds: Int? = null): SessionGoalRef? {
        val body = JSONObject().put("ref", JSONObject().put("id", ref.id).put("revision", ref.revision))
        if (objective != null) body.put("objective", objective)
        if (maxGoalRounds != null) body.put("maxGoalRounds", maxGoalRounds)
        val next = request("POST", sessionPath(sessionId) + "/goal/" + op, body).optJSONObject("ref") ?: return null
        val id = next.optString("id").takeIf { it.isNotBlank() } ?: return null
        return SessionGoalRef(id, next.optInt("revision", ref.revision))
    }

    fun getScheduleCatalog(): List<ScheduledTask> =
        parseScheduledTasks(request("GET", "/dsh-link/mobile/schedules").optJSONArray("items"))

    fun getSessionSchedules(sessionId: String): List<ScheduledTask> =
        parseScheduledTasks(request("GET", sessionPath(sessionId) + "/schedules").optJSONArray("items"))
            .map { if (it.sessionId == null) it.copy(sessionId = sessionId) else it }

    /** 只改标题 / 提示词；原始记录作为 expected 回传（插件只保留 ScheduleRecord 字段）。 */
    fun updateSchedule(sessionId: String, task: ScheduledTask, title: String?, prompt: String?) {
        val body = JSONObject().put("expected", task.raw)
        if (title != null) body.put("title", title)
        if (prompt != null) body.put("prompt", prompt)
        request("PUT", sessionPath(sessionId) + "/schedules/" + java.net.URLEncoder.encode(task.id, "UTF-8"), body)
    }

    fun deleteSchedule(sessionId: String, id: String) {
        request("DELETE", sessionPath(sessionId) + "/schedules/" + java.net.URLEncoder.encode(id, "UTF-8"))
    }

    fun cancelSession(sessionId: String) {
        request("POST", "/dsh-link/mobile/sessions/" + java.net.URLEncoder.encode(sessionId, "UTF-8") + "/cancel", JSONObject())
    }

    /** 设置命名空间视图（settings.describe 透传；值已由服务端脱敏）。 */
    fun getSettings(): MobileSettingsView {
        val root = request("GET", "/dsh-link/mobile/settings")
        val arr = root.optJSONArray("namespaces") ?: org.json.JSONArray()
        return MobileSettingsView(
            writable = root.optBoolean("writable", false),
            namespaces = (0 until arr.length()).map { i ->
                val ns = arr.getJSONObject(i)
                MobileSettingsNamespace(
                    ns = ns.optStringOrEmpty("ns"),
                    value = ns.optJSONObject("value") ?: JSONObject(),
                    user = ns.optJSONObject("user"),
                    applies = ns.optStringOrEmpty("applies", "restart"),
                    revision = ns.optLong("revision", 0L),
                    secrets = (ns.optJSONArray("secrets") ?: org.json.JSONArray()).let { sa ->
                        (0 until sa.length()).map { j ->
                            val s = sa.getJSONObject(j)
                            val path = (s.optJSONArray("path") ?: org.json.JSONArray())
                            val pathList = (0 until path.length()).map { path.getString(it) }
                            pathList to s.optBoolean("set", false)
                        }
                    },
                )
            },
        )
    }

    /**
     * 写一个设置命名空间（settings.update 透传）。返回服务端读回的新视图；
     * 失败抛异常（消息含服务端错误，供行内展示）。
     */
    fun updateSettings(ns: String, patch: JSONObject, expectedRevision: Long? = null): MobileSettingsNamespace {
        val body = JSONObject().put("ns", ns).put("patch", patch)
        expectedRevision?.let { body.put("expectedRevision", it) }
        val root = request("POST", "/dsh-link/mobile/settings/update", body)
        val secrets = (root.optJSONArray("secrets") ?: org.json.JSONArray())
        return MobileSettingsNamespace(
            ns = root.optStringOrEmpty("ns", ns),
            value = root.optJSONObject("value") ?: JSONObject(),
            user = root.optJSONObject("user"),
            applies = root.optStringOrEmpty("applies", "restart"),
            revision = root.optLong("revision", 0L),
            secrets = (0 until secrets.length()).map { j ->
                val s = secrets.getJSONObject(j)
                val path = (s.optJSONArray("path") ?: org.json.JSONArray())
                val pathList = (0 until path.length()).map { path.getString(it) }
                pathList to s.optBoolean("set", false)
            },
        )
    }

    /** 真实 Agent 预设列表（agentPreset.list 透传）。 */
    fun getAgentPresets(): List<MobileAgentPreset> {
        val root = request("GET", "/dsh-link/mobile/agent-presets")
        val arr = root.optJSONArray("presets") ?: org.json.JSONArray()
        return (0 until arr.length()).map { i ->
            val p = arr.getJSONObject(i)
            MobileAgentPreset(
                id = p.getString("id"),
                name = p.optStringOrEmpty("name", p.optStringOrEmpty("id")),
                description = p.optStringOrEmpty("description", ""),
                isDefault = p.optBoolean("isDefault", false),
            )
        }
    }

    fun getLlmModels(): List<MobileModelGroup> =
        parseModelGroups(request("GET", "/dsh-link/mobile/llm-models").optJSONArray("groups"))

    fun getBalance(locale: String): MobileBalance =
        parseBalance(request("GET", "/dsh-link/mobile/balance?locale=" + java.net.URLEncoder.encode(locale, "UTF-8")))

    fun getProviders(): MobileProviderDirectory =
        parseProviderDirectory(request("GET", "/dsh-link/mobile/providers"))

    /** 追加 / 删除供应商 profile.models 条目（插件只写该数组，原条目字段保留）。 */
    fun editProviderModels(
        provider: String,
        add: List<MobileModelDraft> = emptyList(),
        remove: List<String> = emptyList(),
    ): MobileProviderDirectory {
        val body = JSONObject()
            .put("provider", provider)
            .put("add", org.json.JSONArray(add.map { it.toJson() }))
            .put("remove", org.json.JSONArray(remove))
        return parseProviderDirectory(request("POST", "/dsh-link/mobile/providers/models", body))
    }

    /** 单向写入 API 密钥；响应只带「已配置」状态，不回显密钥。 */
    fun setProviderApiKey(provider: String, apiKey: String): MobileProviderDirectory {
        val body = JSONObject().put("provider", provider).put("apiKey", apiKey)
        return parseProviderDirectory(request("POST", "/dsh-link/mobile/providers/credential", body))
    }

    fun addCatalogProvider(provider: String, apiKey: String?): MobileProviderDirectory {
        val body = JSONObject().put("provider", provider)
        if (!apiKey.isNullOrBlank()) body.put("apiKey", apiKey)
        return parseProviderDirectory(request("POST", "/dsh-link/mobile/providers/add", body))
    }

    /** 用电脑端已存的地址与密钥向供应商拉取可用模型（候选，需再勾选写入）。 */
    fun discoverProviderModels(provider: String): List<MobileModelDraft> {
        val root = request("POST", "/dsh-link/mobile/providers/discover", JSONObject().put("provider", provider))
        val arr = root.optJSONArray("models") ?: org.json.JSONArray()
        return (0 until arr.length()).mapNotNull { i ->
            val m = arr.optJSONObject(i) ?: return@mapNotNull null
            val id = m.optStringOrEmpty("id").trim()
            if (id.isEmpty()) return@mapNotNull null
            MobileModelDraft(
                id = id,
                name = m.optNullableString("name"),
                contextWindow = m.optPositiveLong("contextWindow"),
                maxTokens = m.optPositiveLong("maxTokens"),
                inputModalities = m.optStringList("inputModalities"),
            )
        }
    }

    /** 已配对到此电脑端的设备列表（对标 web /dsh-link/devices）。 */
    fun getPairedDevices(): List<MobilePairedDevice> {
        val root = request("GET", "/dsh-link/mobile/devices")
        val arr = root.optJSONArray("devices") ?: org.json.JSONArray()
        return (0 until arr.length()).map { i ->
            val d = arr.getJSONObject(i)
            val name = d.optStringOrEmpty("name", "")
            val rawVia = d.optStringOrEmpty("via", "")
            val via = when {
                rawVia == "relay" || rawVia == "lan" || rawVia == "remote" -> rawVia
                name.endsWith("·云") || name.contains(" · 云端") -> "relay"
                else -> "lan"
            }
            MobilePairedDevice(
                deviceId = d.optStringOrEmpty("deviceId", ""),
                name = name,
                createdAt = d.optLong("createdAt", 0L),
                lastSeenAt = d.optLong("lastSeenAt", 0L),
                via = via,
            )
        }.filter { it.deviceId.isNotBlank() }
    }

    /** 吊销电脑端已配对设备（对标 web POST /dsh-link/revoke）。 */
    fun revokePairedDevice(deviceId: String? = null, name: String? = null) {
        val body = JSONObject()
        if (!deviceId.isNullOrBlank()) body.put("deviceId", deviceId)
        if (!name.isNullOrBlank()) body.put("name", name)
        request("POST", "/dsh-link/mobile/revoke", body)
    }

    private fun requestGetRaw(
        path: String,
        maxBytes: Int = BoundedIo.MAX_JSON_BODY_BYTES,
    ): String {
        if (host.token.isBlank()) throw MobileAuthException("缺少或无效的连接 token", 401)
        val connectMs = 8_000
        val readMs = 12_000
        try {
            // D1：仅幂等 GET 走条件请求（ETag/304）；304 且有缓存副本时直接复用原始文本引用，免重解析大 JSON。
            val result = conditionalJsonGet(host, path, dshAuthHeaders(), connectMs, readMs, maxBytes)
            if (result.code == 304) {
                if (result.text.isEmpty()) {
                    throw MobileApiHttpException(304, "", "资源未修改但本地没有副本，请重试")
                }
                return result.text
            }
            if (result.code !in 200..299) {
                val msg = parseMobileApiError(result.code, result.text)
                if (result.code == 401 || result.code == 403) {
                    JsonHttpCache.clearHost(host.slotKey)
                    throw MobileAuthException(msg, result.code)
                }
                throw MobileApiHttpException(result.code, result.text, msg)
            }
            return result.text
        } catch (e: MobileAuthException) {
            runCatching { Log.w("MobileApi", "GET ${redactRequestPath(path)} remote=${HostHttp.isViaRemote(host)} auth ${e.code}: ${e.message}") }
            throw e
        } catch (e: MobileApiHttpException) {
            runCatching { Log.w("MobileApi", "GET ${redactRequestPath(path)} remote=${HostHttp.isViaRemote(host)} http ${e.httpCode}: ${e.message}") }
            throw e
        } catch (e: Exception) {
            val friendly = friendlyNetworkError(e)
            runCatching { Log.w("MobileApi", "GET ${redactRequestPath(path)} remote=${HostHttp.isViaRemote(host)} ${e.javaClass.simpleName}: ${e.message}") }
            throw IllegalStateException(friendly, e)
        }
    }

    private fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        maxBytes: Int = BoundedIo.MAX_JSON_BODY_BYTES,
    ): JSONObject {
        if (method == "GET") return JSONObject(requestGetRaw(path, maxBytes))
        if (host.token.isBlank()) throw MobileAuthException("缺少或无效的连接 token", 401)
        // 远程路径的超时由 HostHttp 按路由放宽；这里只给局域网的值
        val connectMs = 8_000
        val readMs = 12_000
        try {
            // POST / PUT / DELETE 保留真实 HTTP 方法与请求体；无请求体时补 Content-Type 以通过服务端 CSRF 门禁。
            val writeHeaders = buildList {
                addAll(dshAuthHeaders())
                add("Accept" to "application/json")
                if (body == null) add("Content-Type" to "application/json; charset=utf-8")
            }
            HostHttp.execute(
                host,
                HostHttp.DshRequest(
                    method = method,
                    path = path,
                    body = body?.toString()?.toByteArray(Charsets.UTF_8),
                    headers = writeHeaders,
                    connectTimeoutMs = connectMs,
                    readTimeoutMs = readMs,
                ),
            ).use { response ->
                val code = response.code
                val text = response.body.byteStream().use { BoundedIo.readText(it, maxBytes) }
                if (code !in 200..299) {
                    val msg = parseMobileApiError(code, text)
                    if (code == 401 || code == 403) {
                        JsonHttpCache.clearHost(host.slotKey)
                        throw MobileAuthException(msg, code)
                    }
                    throw MobileApiHttpException(code, text, msg)
                }
                return if (text.isBlank()) JSONObject() else JSONObject(text)
            }
        } catch (e: MobileAuthException) {
            runCatching { Log.w("MobileApi", "$method ${redactRequestPath(path)} remote=${HostHttp.isViaRemote(host)} auth ${e.code}: ${e.message}") }
            throw e
        } catch (e: MobileApiHttpException) {
            runCatching { Log.w("MobileApi", "$method ${redactRequestPath(path)} remote=${HostHttp.isViaRemote(host)} http ${e.httpCode}: ${e.message}") }
            throw e
        } catch (e: Exception) {
            val friendly = friendlyNetworkError(e)
            runCatching { Log.w("MobileApi", "$method ${redactRequestPath(path)} remote=${HostHttp.isViaRemote(host)} ${e.javaClass.simpleName}: ${e.message}") }
            throw IllegalStateException(friendly, e)
        }
    }

    /** DSH 鉴权头（token 头 + 可选 Bearer）。 */
    private fun dshAuthHeaders(): List<Pair<String, String>> = buildList {
        add("x-dsh-link-token" to host.token)
        if (host.token.isNotBlank()) add("Authorization" to "Bearer ${host.token}")
    }
}

internal class MobileAuthException(message: String, val code: Int) : IllegalStateException(message)

internal class FileIntegrityException(message: String) : IllegalStateException(message)

/** [expectedHex] 为空表示对端未提供（旧插件），视为通过；否则大小写不敏感比较。 */
internal fun sha256Matches(expectedHex: String?, bytes: ByteArray): Boolean {
    val expected = expectedHex?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return true
    val actual = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    return actual == expected
}

/** 改动对比 JSON 的读取上限：插件侧已按 5000 行 / 150 万字符截断，转义后留足余量。 */
private const val DIFF_BODY_MAX_BYTES = 4 * 1_048_576

internal fun isPendingHostApproval(error: Throwable): Boolean =
    generateSequence(error) { it.cause }.any { err ->
        val msg = err.message.orEmpty()
        msg.contains("设备待主机确认") ||
            msg.contains("waiting for approval", ignoreCase = true) ||
            msg.contains("pending approval", ignoreCase = true)
    }

internal fun isMobileAuthFailure(error: Throwable): Boolean {
    var cur: Throwable? = error
    while (cur != null) {
        if (cur is MobileAuthException) return true
        val msg = cur.message.orEmpty()
        if (
            msg.contains("缺少或无效的连接 token") ||
            isPendingHostApproval(cur) ||
            msg.contains("设备已被吊销")
        ) return true
        cur = cur.cause
    }
    return false
}

internal fun mobileAuthUserMessage(error: Throwable): String {
    if (isPendingHostApproval(error)) return L.devicePendingApproval
    val unwrapped = if (error is Exception) PinnedSsl.unwrap(error) else error
    if (unwrapped is PinnedSsl.CertChangedException) {
        return L.certificateChanged
    }
    return L.connectionAuthExpired
}

/** 打开设备时凭据已死则丢掉本机配对；待主机确认仍保留。中继转来的拒绝码不算（RFC §7.4）。 */
internal fun shouldDropLocalHostOnOpenAuth(error: Throwable): Boolean {
    if (isPendingHostApproval(error)) return false
    val unwrapped = if (error is Exception) PinnedSsl.unwrap(error) else error
    return isMobileAuthFailure(error) || unwrapped is PinnedSsl.CertChangedException
}

/** 凭据已失效时本机删除仍应放行；其它错误则保留本地记录以免服务端孤儿配对。 */
internal fun shouldBlockLocalHostRemoval(revokeError: Throwable?): Boolean =
    revokeError != null && !isMobileAuthFailure(revokeError)

internal fun friendlyNetworkError(error: Throwable): String {
    remoteErrorText(error)?.let { return it }
    val msg = error.message.orEmpty()
    return when {
        msg.contains("rate limited") -> L.requestTooFrequent
        msg.contains("revision conflict", ignoreCase = true) -> L.settingsChangedElsewhere
        else -> msg.ifBlank { error.javaClass.simpleName }
    }
}

/**
 * 远程路径的失败（RFC §7.5）翻成人话。中继转来的码可能是伪造的，所以这里只给提示，
 * 从不据此删除或修改凭据（§7.4）。不是远程错误时返回 null。
 */
internal fun remoteErrorText(error: Throwable): String? {
    val route = generateSequence(error) { it.cause }.filterIsInstance<RouteConnectException>().firstOrNull() ?: return null
    return when (route) {
        is RouteUnreachableException -> L.remoteRelayUnreachable
        is RouteOfflineException -> L.remoteHostOffline
        is RouteOpenTimeoutException -> L.remoteHostOffline
        is RouteRateLimitedException -> L.requestTooFrequent
        is RouteServerBusyException -> L.remoteBusy
        is RouteRejectedException -> when (route.code) {
            "BAD_MAC", "UNKNOWN_KEY" -> L.remoteCredentialInvalid
            "CLOCK_SKEW" -> L.remoteClockSkew
            "LOCAL_UNAVAILABLE" -> L.remoteLocalUnavailable
            "BOOTSTRAP_UNKNOWN", "BOOTSTRAP_EXPIRED", "BOOTSTRAP_USED" -> L.remoteQrExpired
            "DEVICE_LIMIT", "SERVER_BUSY" -> L.remoteBusy
            else -> L.remoteRelayUnreachable
        }
        else -> L.remoteRelayUnreachable
    }
}

