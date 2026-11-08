package dev.deeplinks.native

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import dev.deeplinks.core.Dsh
import dev.deeplinks.core.DshType
import dev.deeplinks.core.L
import dev.deeplinks.core.decisionInBar
import dev.deeplinks.core.decisionWaitApproval
import dev.deeplinks.native.ui.DshChipTone
import dev.deeplinks.native.ui.DshStatusChip

/**
 * 消息流里的审批（v4 4.3）：状态一行，下面是这次到底要做什么。
 * 要你处理的那条仍在底部决策栏里（[ApprovalDecisionBar]），这里写「等你批准 · 见下方」；
 * 已处理、交给电脑、状态未知各一行。
 * 工作内容（命令原文 / 改哪个文件）来自插件从 tool/call 拼出来的 `detail`，老插件没有就只留状态行。
 * 结果仍走 Web 协议：`allowed-once` / `rejected`。
 */
@Composable
internal fun ApprovalCard(msg: MobileMessage) {
    Column(modifier = Modifier.fillMaxWidth()) {
        when {
            isTerminalRequestStatus(msg.requestStatus) -> ApprovalSentBadge(msg.outcome, msg.requestStatus)
            msg.requestStatus == REQUEST_UNKNOWN -> DshStatusChip(text = L.approvalStatusUnknown, tone = DshChipTone.Remote)
            // 方案 D1-A 诚实降级：没被手机接管的审批只能看状态，点了必然 409
            msg.requestStatus == REQUEST_PENDING && !msg.takenOverByPhone ->
                DshStatusChip(text = L.homeApprovalOnDesktop, tone = DshChipTone.Remote)
            else -> DshStatusChip(
                text = listOfNotNull(L.decisionWaitApproval, msg.toolName, L.decisionInBar).joinToString(" · "),
                tone = DshChipTone.Approval,
            )
        }
        // 只给「有个待审批」等于让人盲批：把命令 / 文件路径这类工作内容一并显示。
        val detail = msg.detail?.trim()?.takeIf { it.isNotEmpty() }
        if (detail != null && !isTerminalRequestStatus(msg.requestStatus)) {
            Text(
                text = detail,
                style = DshType.caption,
                color = Dsh.labelSecondary,
                maxLines = 6,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = DshSpace.s4, start = DshSpace.s4),
            )
        }
    }
}

@Composable
private fun ApprovalSentBadge(outcome: String?, status: String?) {
    val allowed = when {
        status == REQUEST_CANCELLED || status == REQUEST_EXPIRED -> false
        outcome == "rejected" || outcome == "cancelled" -> false
        else -> true
    }
    val label = when (status) {
        REQUEST_CANCELLED -> L.approvalCancelled
        REQUEST_EXPIRED -> L.approvalExpired
        else -> if (allowed) L.approvalAllowedSent else L.approvalRejectedSent
    }
    DshStatusChip(
        text = label,
        tone = DshChipTone.Remote,
        leading = if (allowed) CheckOutline16 else CloseOutline16,
        leadingTint = if (allowed) Dsh.successContent else Dsh.labelTertiary,
    )
}
