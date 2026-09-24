<template>
  <el-tooltip
    v-if="text"
    :content="text"
    placement="top"
    :show-after="120"
    :hide-after="0"
    popper-class="cf-help-popper"
  >
    <span
      class="cf-help"
      role="note"
      :aria-label="`说明：${text}`"
      tabindex="0"
      >?</span
    >
  </el-tooltip>
</template>

<script setup lang="ts">
defineOptions({ name: 'DescriptionHelp' })

/**
 * 字段说明（§3.5）：schema description 原文渲染为 label 旁的问号 help
 * tooltip——参数介绍的统一展示出口。悬浮/聚焦出现，不挤占表单布局。
 */
defineProps<{
  /** schema description 原文；为空时不渲染任何内容。 */
  text?: string
}>()
</script>

<style scoped>
.cf-help {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 1px;
  border-radius: 999px;
  border: 1px solid #d3d8de;
  background: #f7f8f9;
  color: #9aa3ad;
  font-size: 10px;
  font-style: normal;
  line-height: 1;
  cursor: help;
  user-select: none;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.cf-help:hover,
.cf-help:focus-visible {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  outline: none;
}
</style>

<!-- popper 挂在 body 下，需非 scoped 样式 -->
<style>
.cf-help-popper.el-popper {
  max-width: 320px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
