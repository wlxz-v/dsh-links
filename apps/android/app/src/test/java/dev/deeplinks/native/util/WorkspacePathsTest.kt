package dev.deeplinks.native.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WorkspacePathsTest {
    @Test
    fun abbreviateHomePath_macosUsers() {
        assertEquals("~/Dev/dsh-links", abbreviateHomePath("/Users/me/Dev/dsh-links"))
        assertEquals("~", abbreviateHomePath("/Users/me"))
    }

    @Test
    fun abbreviateHomePath_linuxHome() {
        assertEquals("~/proj", abbreviateHomePath("/home/foo/proj"))
    }

    @Test
    fun abbreviateHomePath_leavesVolumesAndRelative() {
        assertEquals("/Volumes/Space/Dev/dsh-links", abbreviateHomePath("/Volumes/Space/Dev/dsh-links"))
        assertEquals("relative/path", abbreviateHomePath("relative/path"))
        assertEquals("", abbreviateHomePath(null))
        assertEquals("", abbreviateHomePath("  "))
    }

    @Test
    fun producedFileName_usesLastSegment() {
        assertEquals("shot.png", producedFileName("notes/shot.png"))
        assertEquals("hi.md", producedFileName("hi.md"))
    }

    @Test
    fun producedFileKind_classifiesByExtension() {
        assertEquals(ProducedFileKind.IMAGE, producedFileKind("a/b.PNG"))
        assertEquals(ProducedFileKind.TEXT, producedFileKind("notes/hi.md"))
        assertEquals(ProducedFileKind.PDF, producedFileKind("out/report.PDF"))
        assertEquals(ProducedFileKind.OTHER, producedFileKind("bin/out"))
    }

    @Test
    fun producedFileKind_officeDocsAreOther() {
        // 表格/文档没有内置渲染，走「交给系统应用打开」。
        assertEquals(ProducedFileKind.OTHER, producedFileKind("报表.xlsx"))
        assertEquals(ProducedFileKind.OTHER, producedFileKind("方案.docx"))
    }

    @Test
    fun mimeForProducedFile_keepsServerMime() {
        assertEquals("application/pdf", mimeForProducedFile("a.pdf", "application/pdf"))
        assertEquals("image/png", mimeForProducedFile("a.png", "image/png; charset=binary"))
    }

    @Test
    fun mimeForProducedFile_fallsBackToExtension() {
        assertEquals("application/pdf", mimeForProducedFile("a.pdf", "application/octet-stream"))
        assertEquals(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            mimeForProducedFile("报表.xlsx", null),
        )
        assertEquals(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            mimeForProducedFile("方案.docx", ""),
        )
        assertEquals("application/zip", mimeForProducedFile("pack.zip", "APPLICATION/OCTET-STREAM"))
        assertEquals("application/octet-stream", mimeForProducedFile("weird.bin", null))
    }

    @Test
    fun safeCacheFileName_stripsSeparatorsAndControlChars() {
        assertEquals("报表.xlsx", safeCacheFileName("out/报表.xlsx"))
        assertEquals("a_b.txt", safeCacheFileName("dir/a:b.txt"))
        assertEquals("file", safeCacheFileName("dir/"))
    }

    @Test
    fun decodeProducedText_truncates() {
        assertEquals("hello", decodeProducedText("hello".toByteArray()))
        assertEquals("ab…", decodeProducedText("abcdef".toByteArray(), maxChars = 2))
    }

    @Test
    fun isProducedTextMime_acceptsJsonAndMarkdown() {
        assertEquals(true, isProducedTextMime("text/plain; charset=utf-8"))
        assertEquals(true, isProducedTextMime("application/json"))
        assertEquals(false, isProducedTextMime("application/pdf"))
    }

    @Test
    fun windowsBackslashPaths_extractLeafFilename() {
        assertEquals("README.md", producedFileName("D:\\DSH\\dsh-links\\README.md"))
        assertEquals("README.md", safeCacheFileName("D:\\DSH\\dsh-links\\README.md"))
    }

    @Test
    fun parseSessionFileLinkPath_handlesFileUrisAndRejectsWeb() {
        assertEquals(
            "D:/DSH/dsh-links/README.md",
            parseSessionFileLinkPath("file:///D:/DSH/dsh-links/README.md#L10-L20"),
        )
        assertEquals(
            "D:/DSH/hello world+1.txt",
            parseSessionFileLinkPath("file:///D:/DSH/hello%20world+1.txt"),
        )
        assertEquals(
            "/Users/alice/notes.md",
            parseSessionFileLinkPath("file://localhost/Users/alice/notes.md"),
        )
        assertNull(parseSessionFileLinkPath("https://example.com/a.txt"))
        assertNull(parseSessionFileLinkPath("relative/path.md"))
    }
}
