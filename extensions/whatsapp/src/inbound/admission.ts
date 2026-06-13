import type { ResolvedChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedWhatsAppInboundPolicy } from "../inbound-policy.js";
import { resolveWhatsAppGroupConversationId } from "./group-conversation.js";

type WhatsAppInboundIngressDecision = Pick<
  ResolvedChannelMessageIngress["ingress"],
  "admission" | "decision" | "decisiveGateId" | "reasonCode"
>;

type WhatsAppInboundSenderAccess = Pick<
  ResolvedChannelMessageIngress["senderAccess"],
  "allowed" | "decision" | "reasonCode" | "providerMissingFallbackApplied"
>;

type WhatsAppInboundCommandAccess = Pick<
  ResolvedChannelMessageIngress["commandAccess"],
  "requested" | "authorized" | "shouldBlockControlCommand" | "reasonCode"
>;

type WhatsAppInboundActivationAccess = Pick<
  ResolvedChannelMessageIngress["activationAccess"],
  "ran" | "allowed" | "shouldSkip" | "reasonCode"
>;

/**
 * Public-safe accepted inbound facts resolved by access control.
 *
 * Keep this as an admission envelope around canonical channel ingress
 * projections. Later PRs can migrate consumers to these projections without
 * publishing raw allowlist material or session-dependent post-admission state.
 */
export type WhatsAppInboundAdmission = {
  accountId: string;
  isSelfChat: boolean;
  account: {
    accountId: string;
    name?: string;
    enabled: boolean;
    sendReadReceipts: boolean;
    selfChatMode?: boolean;
    replyToMode?: ReplyToMode;
  };
  conversation: {
    kind: "direct" | "group";
    id: string;
    groupSessionId: string;
  };
  sender: {
    id: string;
    dmSenderId: string;
    isSamePhone: boolean;
    isDmSenderSamePhone: boolean;
  };
  ingress: WhatsAppInboundIngressDecision;
  senderAccess: WhatsAppInboundSenderAccess;
  commandAccess: WhatsAppInboundCommandAccess;
  activationAccess: WhatsAppInboundActivationAccess;
};

function copyAccount(
  account: ResolvedWhatsAppInboundPolicy["account"],
): WhatsAppInboundAdmission["account"] {
  const copied: WhatsAppInboundAdmission["account"] = {
    accountId: account.accountId,
    enabled: account.enabled,
    sendReadReceipts: account.sendReadReceipts,
  };
  if (account.name) {
    copied.name = account.name;
  }
  if (typeof account.selfChatMode === "boolean") {
    copied.selfChatMode = account.selfChatMode;
  }
  if (account.replyToMode) {
    copied.replyToMode = account.replyToMode;
  }
  return copied;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string";
}

function hasBoolean(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "boolean";
}

function hasIngressShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasString(value, "admission") &&
    hasString(value, "decision") &&
    hasString(value, "decisiveGateId") &&
    hasString(value, "reasonCode")
  );
}

function hasSenderAccessShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasBoolean(value, "allowed") &&
    hasString(value, "decision") &&
    hasString(value, "reasonCode") &&
    hasBoolean(value, "providerMissingFallbackApplied")
  );
}

function hasCommandAccessShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasBoolean(value, "requested") &&
    hasBoolean(value, "authorized") &&
    hasBoolean(value, "shouldBlockControlCommand") &&
    hasString(value, "reasonCode")
  );
}

function hasActivationAccessShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasBoolean(value, "ran") &&
    hasBoolean(value, "allowed") &&
    hasBoolean(value, "shouldSkip") &&
    hasString(value, "reasonCode")
  );
}

export function isWhatsAppInboundAdmission(value: unknown): value is WhatsAppInboundAdmission {
  if (!isRecord(value)) {
    return false;
  }

  const account = value.account;
  const conversation = value.conversation;
  const sender = value.sender;

  return (
    hasString(value, "accountId") &&
    hasBoolean(value, "isSelfChat") &&
    isRecord(account) &&
    hasString(account, "accountId") &&
    hasBoolean(account, "enabled") &&
    hasBoolean(account, "sendReadReceipts") &&
    isRecord(conversation) &&
    (conversation.kind === "direct" || conversation.kind === "group") &&
    hasString(conversation, "id") &&
    hasString(conversation, "groupSessionId") &&
    isRecord(sender) &&
    hasString(sender, "id") &&
    hasString(sender, "dmSenderId") &&
    hasBoolean(sender, "isSamePhone") &&
    hasBoolean(sender, "isDmSenderSamePhone") &&
    hasIngressShape(value.ingress) &&
    hasSenderAccessShape(value.senderAccess) &&
    hasCommandAccessShape(value.commandAccess) &&
    hasActivationAccessShape(value.activationAccess)
  );
}

export function buildWhatsAppInboundAdmission(params: {
  policy: ResolvedWhatsAppInboundPolicy;
  access: ResolvedChannelMessageIngress;
  isGroup: boolean;
  conversationId: string;
  senderId: string;
  dmSenderId: string;
}): WhatsAppInboundAdmission {
  return {
    accountId: params.policy.account.accountId,
    isSelfChat: params.policy.isSelfChat,
    account: copyAccount(params.policy.account),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
      groupSessionId: resolveWhatsAppGroupConversationId(params.conversationId),
    },
    sender: {
      id: params.senderId,
      dmSenderId: params.dmSenderId,
      isSamePhone: params.policy.isSamePhone(params.senderId),
      isDmSenderSamePhone: params.policy.isSamePhone(params.dmSenderId),
    },
    ingress: {
      admission: params.access.ingress.admission,
      decision: params.access.ingress.decision,
      decisiveGateId: params.access.ingress.decisiveGateId,
      reasonCode: params.access.ingress.reasonCode,
    },
    senderAccess: {
      allowed: params.access.senderAccess.allowed,
      decision: params.access.senderAccess.decision,
      reasonCode: params.access.senderAccess.reasonCode,
      providerMissingFallbackApplied: params.access.senderAccess.providerMissingFallbackApplied,
    },
    commandAccess: {
      requested: params.access.commandAccess.requested,
      authorized: params.access.commandAccess.authorized,
      shouldBlockControlCommand: params.access.commandAccess.shouldBlockControlCommand,
      reasonCode: params.access.commandAccess.reasonCode,
    },
    activationAccess: {
      ran: params.access.activationAccess.ran,
      allowed: params.access.activationAccess.allowed,
      shouldSkip: params.access.activationAccess.shouldSkip,
      reasonCode: params.access.activationAccess.reasonCode,
    },
  };
}
