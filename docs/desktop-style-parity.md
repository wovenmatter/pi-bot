# Desktop style reference

Woven Matter desktop is the source of truth; do not copy Enterprise web styling as an
intermediate reference. Audited against Woven Matter `cd0a44cfb87f758be60a07089b21669ac0574b6f`
(`app/App/Views/`). Pi Bot retains its own navigation, settings, onboarding and chat layout.
At 100% browser zoom one CSS pixel corresponds to one macOS logical point.

| Surface          | Desktop source                                                                         | Web contract                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All three themes | `DashboardColors.swift`, `DashboardStyle.swift` / `DashboardPalette`                   | Exact workspace, rail, surface, text, semantic colors and alpha values; primary fill stays #004225                                                                                               |
| Shell            | `DashboardMetrics`, `DashboardRailBackground`                                          | 256 rail, 8 inset, 12 minimum surface radius; layered rim and inner light; no container hover; opaque reduced-transparency fill                                                                  |
| Sidebar rows     | `DashboardSharedViews.swift` / `DashboardRailRow`                                      | 28 height, 12 horizontal padding, 8 gap/radius, 13 regular/medium text; 13 glyph centered in 15 slot; soft hover, strong selection, .78 pressed opacity; rows must not shrink in scrolling lists |
| Section headings | `DashboardDisclosureHeading`                                                           | 26 height, 12 inset, 10 semibold; Pi Bot static headings have no disclosure behavior                                                                                                             |
| Typography       | `DashboardControlMetrics`, `DashboardRailRow`                                          | Native system font; 13 body/rows/input, 12.5 medium buttons, 12 medium segments, 10 semibold rail headings                                                                                       |
| Icons            | `DashboardLucideGlyph`, shared Lucide SVG assets                                       | 1.5 regular stroke, 1.75 controls, 2.5 send arrow; existing Pi Bot semantic icons retained                                                                                                       |
| Buttons          | `DashboardPrimaryButtonStyle`, `DashboardQuietButtonStyle`, `SettingsQuietButtonStyle` | 36 minimum height, 10 radius, 14/12 horizontal padding; primary 1/.9/.78 fill, quiet soft .5/.72/1, text clear/.72/1; .985 press scale, .4 disabled opacity                                      |
| Icon buttons     | `DashboardIconButtonStyle`                                                             | Whisper hover, soft pressed, radius 8, .94 press scale, .4 disabled opacity                                                                                                                      |
| Segments         | `DashboardSegmentedSelector`                                                           | 4 inset, 27 height, 6 segment radius; surface .96 plus hover/pressed overlay even when selected; .98 press scale, .42 disabled                                                                   |
| Inputs           | `DashboardInputModifier`                                                               | 34 minimum height, 12 inset, 10 radius, whisper fill; browser keyboard focus retained                                                                                                            |
| User messages    | `ConversationUserBubble`                                                               | 15 font, 17 x 13 padding, 22 radius, primary .13 fill, 620 maximum outer width                                                                                                                   |
| Rich text        | `ConversationMarkdown.swift`                                                           | 15 body, 22/19/17/15.5 headings, 13.5 inline code, 13 code/table, 680 prose width; existing block spacing largely matches                                                                        |
| Composer         | `DashboardComposer.swift`, `DashboardComposerTextEditor.swift`                         | 18 radius, 12 horizontal inset, 15 text with 4 extra points of line spacing, foreground .06 rim; neutral/focused shadow; translucent blurred surface                                             |
| Send/stop        | `DashboardComposer.sendControl`                                                        | 36 circle, 16 send glyph, primary fill, dark ring, .4 disabled; no invented hover recoloring or press scale                                                                                      |

## Corrections from the inherited stylesheet

Reduced oversized/heavy sidebar glyphs; matched vector stroke roles; prevented flex compression
of rows/headings; added missing disabled and primary/quiet/text pressed states; retained selected
segment fill while hovering/pressing; aligned composer line spacing and translucent material;
removed custom send/stop hover and scale effects; added reduced-transparency rail/composer support.
Existing exact palette values and shell dimensions were retained.

## Rendering boundaries

SwiftUI continuous corners and macOS Liquid Glass have no pixel-identical browser primitive.
The web uses rounded CSS corners and backdrop blur; OS tint/refraction cannot be reproduced
exactly. System fonts resolve to SF on macOS and to the platform font elsewhere. Lucide-react's
pinned icon version can differ in path geometry from the desktop asset catalog. Pi Bot-only
screens use the shared controls and colors but keep their existing composition. Touch targets
remain 44 pixels on coarse pointers. Browser focus indicators and keyboard semantics remain.


## Chat and settings follow-up

The active desktop response renderer is `ConversationResponse.swift` /
`ConversationResponseAttributedText`, not just the older SwiftUI `ConversationMarkdown`.
The follow-up matches its 680-point response width, 15-point body with 5-point extra line
spacing, native bold emphasis, unpadded inline code, 13-point code with 3-point extra line
spacing, single primary .05 code surface, and collapsed table grid (13-point text, 9-point
cell padding, foreground .09 borders). Streaming response text uses foreground .76.
User-message line spacing follows `ConversationUserBubble` (15-point text plus 4 points).
Pi Bot's existing code copy control, message labels, thread controls and composer layout stay.

Settings now uses `SettingsPage`'s 22-point semibold title and `SettingsMenuPicker`'s
36-point quiet trigger, 12.5-point medium type, 10-point chevron, clear/soft-hover/soft-pressed
fills. Native HTML select semantics and keyboard focus are retained; the operating system's
option popup is not a custom reproduction of SwiftUI's popover. The profile editor uses the
workspace surface from `SettingsCard`, keeping Pi Bot's existing border and section arrangement.

Validation uses a separate loopback-only server with a faux model, extraction disabled, a
fresh temporary SQLite database/config/key, and a nonfunctional placeholder credential solely
to exercise onboarding status. No real provider is registered in that instance. It serves the
same worktree build as the code being checked; its config and data are never deployed to the
normal preview service.


The sidebar container stays visually fixed on hover, per the desktop parity correction.
Only its interactive children receive hover treatments; the rail rim does not change.
