package dev.deeplinks.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 双端契约测试（B2）：读仓库里的 `spec/protocol-vectors.json`，逐条断言 App 的解析器与插件
 * 承诺的形状一致。插件侧 `test/protocol-vectors.test.mjs` 断言同一份文件的服务端形状 ——
 * 两边都对着同一份来源，谁先改了帧而另一边没跟上，这里就会红。
 *
 * 工作目录是 `apps/android/app`，所以 spec 在 `../../../spec/`。
 */
class ProtocolVectorsTest {

    private fun specFile(): File {
        val candidates = listOf(
            File("../../../spec/protocol-vectors.json"),
            File("../../spec/protocol-vectors.json"),
            File("spec/protocol-vectors.json"),
        )
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("找不到 spec/protocol-vectors.json，试过 ${candidates.joinToString { it.absolutePath }}")
    }

    private fun spec(): JSONObject = JSONObject(specFile().readText(Charsets.UTF_8))

    private fun frames(root: JSONObject): List<JSONObject> {
        val array = root.getJSONArray("frames")
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    @Test
    fun sessionStateFramesParseIntoSameFields() {
        val root = spec()
        val frames = frames(root).filter { it.getString("event") == "session/state" }
        assertTrue("spec 里至少要有 session/state 帧", frames.isNotEmpty())
        for (frame in frames) {
            val data = frame.getJSONObject("data")
            val fields = parseHostStateFields(data.toString())
            assertNotNull("session/state 应该能解析：$data", fields)
            fields!!
            assertEquals(data.getString("sessionId"), fields.sessionId)
            assertEquals(data.optString("state"), fields.state)
            assertEquals(data.optString("title"), fields.title)
            assertEquals(data.optString("origin"), fields.origin)
            assertEquals(data.optLong("seq"), fields.seq)
            assertEquals(data.optBoolean("notify", true), fields.notify)
            assertEquals(data.optString("approvalId").takeIf { it.isNotBlank() }, fields.approvalId)
            assertEquals(data.optString("approvalToolName").takeIf { it.isNotBlank() }, fields.approvalToolName)
            assertEquals(data.optString("approvalDetail").takeIf { it.isNotBlank() }, fields.approvalDetail)
            assertEquals(data.optString("questionId").takeIf { it.isNotBlank() }, fields.questionId)
            assertEquals(data.optString("questionText").takeIf { it.isNotBlank() }, fields.questionText)
        }
    }

    @Test
    fun everyRequiredFrameKeyIsInSampleData() {
        for (frame in frames(spec())) {
            val data = frame.getJSONObject("data")
            for (key in frame.optJSONArray("required")?.let { array ->
                    (0 until array.length()).map { array.getString(it) }
                } ?: emptyList()) {
                assertTrue("帧 ${frame.getString("event")} 缺字段 $key", data.has(key))
            }
        }
    }

    @Test
    fun eventSeqFillsMissingFrameSeq() {
        val fields = parseHostStateFields("""{"sessionId":"s-1","state":"idle"}""", eventSeq = 42)
        assertEquals(42L, fields!!.seq)
    }

    @Test
    fun blankSessionIdIsIgnored() {
        assertEquals(null, parseHostStateFields("""{"state":"idle"}"""))
        assertEquals(null, parseHostStateFields("not json"))
    }
}
