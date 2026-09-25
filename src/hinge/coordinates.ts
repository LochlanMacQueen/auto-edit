/**
 * Hinge touch map, measured on Phone Farm #1 (iPhone 13, 390×844 pt, scale 3)
 * on 2026-09-13 against Hinge's current build. Points are in screen points.
 *
 * Discover is one long vertical card per person: a sticky header with the
 * name, then photo cards and prompt cards (each with its own heart at the
 * lower right), a vitals card (age, height, location, job, school, religion,
 * hometown, dating intention, relationship type), and a floating undo + X
 * pinned bottom-left. The tab bar hides once the card is scrolled.
 */
export interface Point { x: number; y: number }

export interface HingeCoordinates {
    screenSize: { width: number; height: number };
    /** Bottom tab bar (visible on Discover top and on other tabs). */
    tabs: { discover: Point; standouts: Point; likesYou: Point; matches: Point; profile: Point };
    /** Sticky Discover header. */
    header: { nameCenter: Point; rewind: Point; more: Point };
    /** Filter chips visible only at the top of Discover. */
    filters: { settings: Point; signals: Point; age: Point; height: Point };
    /** Floating action buttons; they drop by 70pt once the tab bar hides. */
    floating: {
        undoWithTabBar: Point; passWithTabBar: Point;
        undoScrolled: Point; passScrolled: Point;
    };
    /** Heart button x on photo/prompt cards; y is card-relative (bottom-right corner). */
    cardHeart: { x: number; insetFromCardBottom: number };
    /** First photo card on an unscrolled Discover profile. */
    firstPhoto: { top: number; bottom: number; heart: Point };
    /** Like sheet after tapping a heart (keyboard shown). */
    likeSheet: { comment: Point; rose: Point; sendLike: Point; keyboardDone: Point; dismissSwipe: { from: Point; to: Point } };
    /** A safe full-card scroll gesture. */
    scroll: { from: Point; to: Point; durationMs: number };
}

export const HINGE_IPHONE13: HingeCoordinates = {
    screenSize: { width: 390, height: 844 },
    tabs: {
        discover: { x: 36, y: 785 },
        standouts: { x: 115, y: 785 },
        likesYou: { x: 195, y: 785 },
        matches: { x: 272, y: 785 },
        profile: { x: 352, y: 785 },
    },
    header: { nameCenter: { x: 195, y: 70 }, rewind: { x: 312, y: 137 }, more: { x: 352, y: 137 } },
    filters: { settings: { x: 36, y: 80 }, signals: { x: 98, y: 80 }, age: { x: 183, y: 80 }, height: { x: 275, y: 80 } },
    floating: {
        undoWithTabBar: { x: 48, y: 640 }, passWithTabBar: { x: 48, y: 703 },
        undoScrolled: { x: 48, y: 710 }, passScrolled: { x: 48, y: 773 },
    },
    cardHeart: { x: 336, insetFromCardBottom: 35 },
    firstPhoto: { top: 175, bottom: 525, heart: { x: 336, y: 490 } },
    likeSheet: {
        comment: { x: 195, y: 410 },
        rose: { x: 85, y: 500 },
        sendLike: { x: 250, y: 500 },
        keyboardDone: { x: 340, y: 743 },
        dismissSwipe: { from: { x: 195, y: 130 }, to: { x: 195, y: 700 } },
    },
    scroll: { from: { x: 200, y: 700 }, to: { x: 200, y: 250 }, durationMs: 500 },
};

export const HINGE_BUNDLE_ID = 'co.hinge.mobile.ios';
