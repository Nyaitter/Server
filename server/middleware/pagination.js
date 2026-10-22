'use strict';

const MAX_LIST_OFFSET = 10_000;

/** Reject deep offsets before SQL query execution; cursor pagination remains available. */
function rejectExcessiveOffset(req, res, next) {
    const raw = req.query?.offset;
    if (raw === undefined) return next();

    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
        const offset = Number(value);
        if (offset === Number.POSITIVE_INFINITY || (Number.isFinite(offset) && offset > MAX_LIST_OFFSET)) {
            return res.status(400).json({
                error: `offset exceeds the maximum supported value (${MAX_LIST_OFFSET}); use cursor pagination where available.`,
                max_offset: MAX_LIST_OFFSET,
            });
        }
    }
    return next();
}

module.exports = { MAX_LIST_OFFSET, rejectExcessiveOffset };
