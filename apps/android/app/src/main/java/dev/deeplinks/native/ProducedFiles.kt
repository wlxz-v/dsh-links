package dev.deeplinks.native

import dev.deeplinks.native.DshIconSize
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import dev.deeplinks.core.DshType

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import dev.deeplinks.core.dshRipple
import dev.deeplinks.core.Dsh
import dev.deeplinks.core.L
import dev.deeplinks.native.util.ProducedFileKind
import dev.deeplinks.native.util.decodeProducedText
import dev.deeplinks.native.util.isProducedTextMime
import dev.deeplinks.native.util.mimeForProducedFile
import dev.deeplinks.native.util.producedFileKind
import dev.deeplinks.native.util.producedFileName
import dev.deeplinks.native.util.safeCacheFileName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val PREVIEW_MAX_EDGE = 2048

internal fun decodeSampledBitmap(bytes: ByteArray, maxEdge: Int = PREVIEW_MAX_EDGE): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val width = bounds.outWidth
    val height = bounds.outHeight
    if (width <= 0 || height <= 0) return null
    var sample = 1
    while (width / sample > maxEdge || height / sample > maxEdge) sample *= 2
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
}

internal sealed interface ProducedPreview {
    data class Image(val bitmap: Bitmap) : ProducedPreview
    data class Text(val path: String, val body: String) : ProducedPreview
    /** PDF 直接在 App 内翻页看（PdfRenderer 是系统自带，不引第三方库）。 */
    data class Pdf(val name: String, val pages: List<Bitmap>, val truncated: Boolean) : ProducedPreview
}

/** PDF 前若干页渲染成位图。页数有上限：整本渲进内存会在手机上 OOM。 */
internal fun renderPdfPages(file: java.io.File, maxPages: Int = PDF_PREVIEW_MAX_PAGES): Pair<List<Bitmap>, Boolean> {
    val pages = mutableListOf<Bitmap>()
    var truncated = false
    android.os.ParcelFileDescriptor.open(file, android.os.ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        android.graphics.pdf.PdfRenderer(fd).use { renderer ->
            val count = renderer.pageCount
            truncated = count > maxPages
            for (index in 0 until minOf(count, maxPages)) {
                renderer.openPage(index).use { page ->
                    // 按屏宽的一半渲染再放大显示：手机上够清楚，内存占用小一个数量级。
                    val width = (PDF_PREVIEW_WIDTH_PX).coerceAtLeast(320)
                    val height = (width * page.height.toFloat() / page.width.toFloat()).toInt().coerceAtLeast(1)
                    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                    bitmap.eraseColor(android.graphics.Color.WHITE)
                    page.render(bitmap, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    pages += bitmap
                }
            }
        }
    }
    return pages to truncated
}

/**
 * 下载到本机缓存再交给系统应用打开（WPS / Office / 阅读器 / 播放器）。
 * 返回 false 表示这台手机没有能接过该类型的应用。
 */
internal fun openWithSystemApp(context: android.content.Context, path: String, mime: String, bytes: ByteArray): Boolean {
    return try {
        val dir = java.io.File(context.cacheDir, "opened").apply { mkdirs() }
        // 只留最近一次的留档：缓存目录不该无限长。
        dir.listFiles()?.forEach { it.delete() }
        val file = java.io.File(dir, safeCacheFileName(path)).apply { writeBytes(bytes) }
        val uri = androidx.core.content.FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file,
        )
        val view = android.content.Intent(android.content.Intent.ACTION_VIEW)
            .setDataAndType(uri, mime)
            .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val chooser = android.content.Intent.createChooser(view, producedFileName(path))
            .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(chooser)
        true
    } catch (e: android.content.ActivityNotFoundException) {
        false
    } catch (e: Exception) {
        false
    }
}

/** 8 MiB 上限是在读流时抛的 IOException，外面又包了一层本地化文案，所以要顺 cause 链找。 */
internal fun isFileTooLarge(error: Throwable?): Boolean {
    var current = error
    var depth = 0
    while (current != null && depth < 5) {
        if (current.message?.contains("too large", ignoreCase = true) == true) return true
        current = current.cause
        depth++
    }
    return false
}

private const val PDF_PREVIEW_MAX_PAGES = 5
private const val PDF_PREVIEW_WIDTH_PX = 1080

/**
 * 本轮产出：对标 DSH 0.1.5 侧栏打开文件。
 * 图片/文本点击预览，失败可重试；其它文件点按或长按复制路径。
 */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
internal fun ProducedFilesRow(
    files: List<String>,
    onFetchFile: ((String) -> Pair<String, ByteArray>)? = null,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var preview by remember { mutableStateOf<ProducedPreview?>(null) }
    var loadingPath by remember { mutableStateOf<String?>(null) }
    var errorPath by remember { mutableStateOf<String?>(null) }
    var copiedPath by remember { mutableStateOf<String?>(null) }
    // 不能只改芯片文字：打开失败/超限要留一行说明，否则看起来还是「点了没反应」。
    var notice by remember { mutableStateOf<String?>(null) }

    androidx.compose.runtime.DisposableEffect(preview) {
        val owned = preview
        onDispose {
            when (owned) {
                is ProducedPreview.Image -> if (!owned.bitmap.isRecycled) owned.bitmap.recycle()
                is ProducedPreview.Pdf -> owned.pages.forEach { if (!it.isRecycled) it.recycle() }
                else -> Unit
            }
        }
    }

    LaunchedEffect(copiedPath) {
        if (copiedPath == null) return@LaunchedEffect
        delay(1_400)
        copiedPath = null
    }

    fun copyPath(path: String) {
        val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
            as android.content.ClipboardManager
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("workspace path", path))
        copiedPath = path
        errorPath = null
    }

    fun openPath(path: String) {
        val fetch = onFetchFile
        if (fetch == null) {
            copyPath(path)
            return
        }
        val kind = producedFileKind(path)
        loadingPath = path
        errorPath = null
        notice = null
        scope.launch(Dispatchers.IO) {
            val result = runCatching { fetch(path) }
            val resolved = result.mapCatching { (serverMime, bytes) ->
                when {
                    kind == ProducedFileKind.IMAGE || serverMime.startsWith("image/") -> {
                        val bmp = decodeSampledBitmap(bytes)
                        if (bmp != null) ProducedPreview.Image(bmp) to null else null to "decode"
                    }
                    kind == ProducedFileKind.TEXT || isProducedTextMime(serverMime) -> {
                        ProducedPreview.Text(path, decodeProducedText(bytes)) to null
                    }
                    kind == ProducedFileKind.PDF -> {
                        val dir = java.io.File(context.cacheDir, "opened").apply { mkdirs() }
                        val file = java.io.File(dir, safeCacheFileName(path)).apply { writeBytes(bytes) }
                        val rendered = runCatching { renderPdfPages(file) }.getOrNull()
                        if (rendered != null && rendered.first.isNotEmpty()) {
                            ProducedPreview.Pdf(producedFileName(path), rendered.first, rendered.second) to null
                        } else {
                            null to "pdf"
                        }
                    }
                    else -> {
                        val opened = openWithSystemApp(context, path, mimeForProducedFile(path, serverMime), bytes)
                        null to if (opened) "external" else "no-app"
                    }
                }
            }
            withContext(Dispatchers.Main) {
                loadingPath = null
                resolved.fold(
                    onSuccess = { (nextPreview, status) ->
                        when {
                            nextPreview != null -> preview = nextPreview
                            status == "no-app" -> notice = L.noAppToOpen
                            status != "external" -> errorPath = path
                        }
                    },
                    onFailure = { error ->
                        errorPath = path
                        if (isFileTooLarge(error)) notice = L.fileTooLarge
                    },
                )
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(DshRadius.container))
            .background(Dsh.bgInput)
            .padding(horizontal = DshSpace.s12, vertical = DshSpace.s12),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                FileOutline16,
                contentDescription = null,
                tint = Dsh.labelTertiary,
                modifier = Modifier.size(DshIconSize.sm),
            )
            Spacer(Modifier.width(DshSpace.s12))
            Text(
                L.producedFiles,
                color = Dsh.labelPrimary,
                style = DshType.title,
                fontWeight = FontWeight(500),
                lineHeight = 24.sp,
            )
        }
        if (files.isEmpty()) return@Column
        Spacer(Modifier.height(DshSpace.s8))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(DshSpace.s8),
            verticalArrangement = Arrangement.spacedBy(DshSpace.s8),
        ) {
            files.forEach { path ->
                val name = producedFileName(path)
                val loading = loadingPath == path
                val failed = errorPath == path
                val copied = copiedPath == path
                val label = when {
                    loading -> L.loadingFile
                    failed -> L.retry
                    copied -> L.copied
                    else -> name
                }
                Box(
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .clip(RoundedCornerShape(DshRadius.full))
                        .background(Dsh.bgTrack)
                        .semantics {
                            role = Role.Button
                            contentDescription = when {
                                failed -> L.openFileFailed
                                else -> "${L.producedFiles}: $name"
                            }
                        }
                        .combinedClickable(
                            onClick = { if (!loading) openPath(path) },
                            onLongClick = { copyPath(path) },
                        )
                        .padding(horizontal = DshSpace.s12, vertical = DshSpace.s8),
                    contentAlignment = Alignment.Center,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (loading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(14.dp),
                                strokeWidth = 1.5.dp,
                                color = Dsh.labelSecondary,
                            )
                            Spacer(Modifier.width(DshSpace.s8))
                        }
                        Text(
                            label,
                            color = if (failed) Dsh.error else Dsh.labelPrimary,
                            style = DshType.body,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
        notice?.let { message ->
            Spacer(Modifier.height(DshSpace.s8))
            Text(
                message,
                color = Dsh.labelSecondary,
                style = DshType.caption,
            )
        }
    }

    preview?.let { current -> ProducedPreviewDialog(current, onDismiss = { preview = null }) }
}

/** 图片 / 文本预览对话框（本轮产出与工作区文件浏览共用）。 */
@Composable
internal fun ProducedPreviewDialog(
    current: ProducedPreview,
    onDismiss: () -> Unit,
    onQuote: ((String) -> Unit)? = null,
) {
    when (current) {
        is ProducedPreview.Image -> Dialog(onDismissRequest = { onDismiss() }) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .semantics {
                        role = Role.Button
                        contentDescription = L.close
                    }
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = dshRipple(),
                    ) { onDismiss() }
                    .padding(DshSpace.s16),
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    bitmap = current.bitmap.asImageBitmap(),
                    contentDescription = L.producedFiles,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(DshRadius.container)),
                )
            }
        }
        is ProducedPreview.Text -> FilePreviewDialog(current.path, current.body, onDismiss, onQuote)
        is ProducedPreview.Pdf -> Dialog(onDismissRequest = { onDismiss() }) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(0.85f)
                    .clip(RoundedCornerShape(DshRadius.container))
                    .background(Dsh.bgInput)
                    .navigationBarsPadding()
                    .padding(DshSpace.s16),
            ) {
                Text(
                    current.name,
                    color = Dsh.labelPrimary,
                    style = DshType.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(DshSpace.s8))
                val scroll = androidx.compose.foundation.rememberScrollState()
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .verticalScroll(scroll),
                    verticalArrangement = Arrangement.spacedBy(DshSpace.s12),
                ) {
                    current.pages.forEachIndexed { index, bitmap ->
                        Image(
                            bitmap = bitmap.asImageBitmap(),
                            contentDescription = "${current.name} ${index + 1}",
                            contentScale = androidx.compose.ui.layout.ContentScale.FillWidth,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(DshRadius.container)),
                        )
                    }
                }
                if (current.truncated) {
                    Spacer(Modifier.height(DshSpace.s8))
                    Text(L.pdfPagesTruncated, color = Dsh.labelSecondary, style = DshType.caption)
                }
                Spacer(Modifier.height(DshSpace.s8))
                Text(
                    L.close,
                    color = Dsh.labelSecondary,
                    style = DshType.body,
                    modifier = Modifier
                        .align(Alignment.End)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = dshRipple(),
                        ) { onDismiss() }
                        .padding(DshSpace.s8),
                )
            }
        }
    }
}
