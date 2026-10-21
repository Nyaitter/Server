'use strict';

const { stagePayload } = require('./CallService');
const { normalizeGroupId } = require('./GroupService');
const { normalizeSpaceId } = require('./SpaceService');

const PUBLIC_GROUP_VISIBILITIES = new Set(['open', 'open_invite']);

function isPublicGroup(group) {
  return Boolean(group) && PUBLIC_GROUP_VISIBILITIES.has(String(group.visibility || '').toLowerCase());
}

function isPublicStage(stage) {
  return Boolean(stage) && String(stage.visibility || '').toLowerCase() === 'public';
}

async function getPublicGroup(db, id) {
  const groupId = normalizeGroupId(id);
  if (!groupId) return null;
  const group = await db.getGroupById(groupId);
  return isPublicGroup(group) ? group : null;
}

async function getPublicStage(db, id) {
  const spaceId = normalizeSpaceId(id);
  if (!spaceId) return null;
  const stage = stagePayload(await db.getSpaceById(spaceId));
  if (!isPublicStage(stage)) return null;
  const host = await db.getUserById(stage.owner_id);
  return { stage, host };
}

function decodeId(value) {
  try {
    return decodeURIComponent(String(value || '').trim());
  } catch (_) {
    return '';
  }
}

/**
 * Resolve a share URL (direct path or SPA hash) to an embed target.
 */
function parseEmbedTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;

  const path = parsed.pathname;
  const hash = decodeId(parsed.hash.replace(/^#\/?/, ''));
  const groupPath = path.match(/\/(?:groups?)\/([^/]+)\/?$/i);
  const stagePath = path.match(/\/(?:stages?|spaces?)\/([^/]+)\/?$/i);
  const groupHash = hash.match(/^groups?\/([^/]+)$/i);
  const stageHash = hash.match(/^(?:stages?|spaces?)\/([^/]+)$/i);

  if (groupPath) return { kind: 'group', id: decodeId(groupPath[1]) };
  if (stagePath) return { kind: 'stage', id: decodeId(stagePath[1]) };
  if (groupHash) return { kind: 'group', id: decodeId(groupHash[1]) };
  if (stageHash) return { kind: 'stage', id: decodeId(stageHash[1]) };
  return null;
}

module.exports = {
  PUBLIC_GROUP_VISIBILITIES,
  isPublicGroup,
  isPublicStage,
  getPublicGroup,
  getPublicStage,
  parseEmbedTarget,
};
