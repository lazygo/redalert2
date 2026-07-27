export enum OrderFeedbackType {
    None = 0,
    Move = 1,
    Attack = 2,
    Enter = 3,
    Capture = 4,
    SpecialAttack = 5,
    /** Barracks / war factory rally point (EVA, not unit voice). */
    RallyPoint = 6,
    /** Fighter aircraft acquiring a target (EVA Select Target). */
    SelectTarget = 7,
}
