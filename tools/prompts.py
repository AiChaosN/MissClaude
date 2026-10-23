#!/usr/bin/env python3
"""Prompt specs for every generated MissClaude asset.

Writes one text file per asset into art/prompts/. Edits ("edit" kind) are
run against an existing image and must stay pixel-aligned with it; poses
("pose" kind) are new drawings that use the chibi as the character reference.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "art" / "prompts"

GREEN_BG = (
    "Background: replace the background with a perfectly flat, uniform chroma-key green "
    "(#00FF00) that fills the entire canvas edge to edge - no gradient, no ground, no cast "
    "shadow, no decorations (remove all floating flowers, sparkles and petals), no text, no "
    "watermark. Keep the character's dark outline crisp, with no green spill or glow on her."
)

KEEP_ALL = (
    "Keep everything else exactly identical to Image 1 and pixel-aligned with it: same canvas "
    "size, framing, character position and scale, line art, colors, shading, every hair strand, "
    "ribbon, tassel, frill and accessory."
)

CHAR_LOCK = (
    "Character lock (do not redesign her): the exact same chibi girl as Image 1 - big-head chibi "
    "proportions (head about one third of her height); very long flowing orange hair reaching "
    "past her knees, side-swept bangs, a thin braid on her left side; amber-orange eyes with thick "
    "dark lashes and soft pink blush; on her left side of the head (viewer's right) a large orange "
    "daisy ornament with an amber gem center plus a black ribbon bow with cream tails and a gold "
    "tassel; gold tassel earrings; cream-white blouse with frilly high collar, black cravat bow and "
    "orange flower brooch, puffy long sleeves with frilled cuffs, white gloves; black corset waist "
    "cincher with gold chain and orange tassel; layered skirt - cream with fine orange vine "
    "embroidery and frilly petticoat hem, black and orange panels with gold trim and orange flower "
    "motifs, black bows with orange flowers and gold tassels; white lace-up heeled ankle boots; "
    "dark brown leather book with an orange flower emblem. Same clean anime line art with dark "
    "brown outlines, soft cel shading and warm palette as Image 1."
)

COMPOSE = (
    "Composition: square 1:1 canvas, full body visible and centered, nothing cropped (all of her "
    "hair, skirt and boots inside the frame with a small margin). Draw her at the same scale as "
    "in Image 1 - her head the same size."
)


def edit(change: str, green: bool = False) -> str:
    parts = [
        "Use case: identity-preserve / precise-object-edit",
        "Asset type: animation frame for a desktop-pet sprite (frames are swapped at runtime, so "
        "alignment with Image 1 matters)",
        "Input images: Image 1: edit target",
        f"Change: {change}",
    ]
    if green:
        parts.append(GREEN_BG)
    parts.append(KEEP_ALL)
    return "\n".join(parts)


def pose(request: str, extra_refs: str = "") -> str:
    return "\n".join([
        "Use case: identity-preserve (same character, new pose)",
        "Asset type: desktop-pet sprite (will be chroma-keyed to transparency)",
        "Input images: Image 1: character reference (outfit, face, proportions, art style)"
        + extra_refs,
        f"Primary request: {request}",
        COMPOSE,
        GREEN_BG,
        CHAR_LOCK,
    ])


EYES_ONLY = (
    " Keep her eyebrows, mouth (the same small closed smile), blush, bangs and head position "
    "unchanged."
)

PROMPTS = {
    # --- canonical base: only the background changes, used to derive the alpha mask
    "base_green": (
        "Use case: background-extraction\n"
        "Asset type: desktop-pet sprite source (will be chroma-keyed to transparency)\n"
        "Input images: Image 1: edit target\n"
        "Change: replace ONLY the background. " + GREEN_BG + " Also remove the soft orange ground "
        "shadow and the petals lying under her boots.\n"
        "The character must stay 100% unchanged and pixel-aligned with Image 1: identical pose, "
        "position, scale, silhouette, line art, colors, shading, every hair strand, ribbon, tassel "
        "and frill."
    ),
    # --- face variants on the idle pose (face patches are cut out of these)
    "eyes_half": edit(
        "ONLY her eyes: both eyes half-closed, as in the middle of a blink - the upper eyelids with "
        "the same thick dark lashes lowered to cover the upper half of the irises." + EYES_ONLY),
    "look_left": edit(
        "ONLY her eyes: both irises and pupils shift to look toward the left edge of the image "
        "(viewer's left), as if glancing at something beside her. Eye shape and lashes "
        "unchanged." + EYES_ONLY),
    "look_right": edit(
        "ONLY her eyes: both irises and pupils shift to look toward the right edge of the image "
        "(viewer's right), as if glancing at something beside her. Eye shape and lashes "
        "unchanged." + EYES_ONLY),
    "happy": edit(
        "ONLY her facial expression: eyes closed in happy upward-arched curves (a ^ ^ smile-eyes "
        "shape) with the same lash style, mouth open in a big joyful smile, slightly stronger pink "
        "blush on both cheeks. Head position, bangs and hair unchanged."),
    "surprised": edit(
        "ONLY her facial expression: eyes opened wide in surprise (round eyes, slightly smaller "
        "pupils, bright highlights), mouth a small round open 'o', light blush. Head position, "
        "bangs and hair unchanged."),
    "talk": edit(
        "ONLY her mouth: open it slightly as if in the middle of saying a word - a small rounded "
        "open mouth with a soft pink inside, keeping the same friendly expression. Eyes, blush, "
        "bangs and head position unchanged."),
    "pout": edit(
        "ONLY her facial expression: a cute pouty sulk - cheeks slightly puffed, mouth a small "
        "pouting wavy line, eyes looking slightly up at the viewer with a mildly annoyed but "
        "adorable look, a bit more blush. Head position, bangs and hair unchanged."),
    # --- face variants on the sitting pose (input: sit_read)
    "sit_blink": edit(
        "ONLY her eyes: close both eyes gently (soft downward-curved closed-eye lash lines in the "
        "same lash style), as in a blink while reading. Keep the flat chroma-green background and "
        "keep her mouth, blush, bangs, head position and the book unchanged."),
    "sleep": edit(
        "ONLY her face: she has dozed off while reading - eyes peacefully closed (relaxed closed "
        "lash curves), mouth slightly open in a tiny relaxed sleepy 'o', a soft blush. Keep the "
        "flat chroma-green background and keep the head position, bangs, hands and the book "
        "unchanged."),
    # --- arm variants on the idle pose, on green so the moved arm gets clean alpha
    "wave_a": edit(
        "ONLY her free arm (her left arm, on the viewer's right, currently hanging down with an "
        "open gloved hand): raise it so the hand is beside her head at about eye height, waving at "
        "the viewer - elbow bent, forearm pointing up, open palm facing the viewer, fingers "
        "together, hand tilted slightly outward. The frilled cuff and sleeve follow the arm. Where "
        "the arm used to be, show the hair and dress that were behind it. Her other hand keeps "
        "holding the book exactly as before; her face stays exactly the same.", green=True),
    "wave_b": edit(
        "ONLY her raised waving hand: bend it at the wrist so the open palm tilts inward toward "
        "her head by about 30 degrees - the other extreme of a friendly waving motion. The forearm, "
        "elbow, sleeve and cuff stay exactly where they are. Keep the flat chroma-green background."),
    "think": edit(
        "ONLY her free arm and her eyes: bend her free arm (on the viewer's right) so her gloved "
        "index finger touches her chin in a cute thinking gesture, and her eyes look up toward the "
        "upper right as if pondering. Where the arm used to be, show the hair and dress that were "
        "behind it. Her other hand keeps holding the book exactly as before; mouth stays the same "
        "small smile.", green=True),
    # --- layer decomposition for the rigged idle pose (all on chibi_ref, white bg kept)
    "rm_arm_free": edit(
        "remove ONLY her free arm (on the viewer's right: the puffy sleeve from the shoulder down, the "
        "frilled cuff and the white-gloved hand), as if that arm were hidden behind her back. Where it "
        "was, draw what is behind it: the side of her blouse and corset, the skirt, and the long orange "
        "hair, continuing the existing strands naturally. Keep the white background."),
    "rm_arm_book": edit(
        "remove ONLY her book-holding arm (on the viewer's left: sleeve, frilled cuff and gloved hand) "
        "together with the brown book. Where they were, draw what is behind them: her blouse, the collar "
        "frills, the black cravat, the corset and the long orange hair, continuing the existing strands "
        "and fabric naturally. Keep the white background."),
    "rm_dangles": edit(
        "remove ONLY the things that hang down: the two cream ribbon tails, the gold tassel and the "
        "orange cord hanging below her black hair bow, and the dangling tassel earring under her ear. "
        "Where they were, draw the long orange hair and the ear behind them, continuing the strands "
        "naturally. Keep the black bow knot, the flower ornament and the white background."),
    "seg_hair": (
        "Use case: precise-object-edit (segmentation mask)\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\n"
        "Input images: Image 1: edit target\n"
        "Change: recolor ALL of her hair - every strand of the long hair on both sides, the bangs, the "
        "side locks, the braid and the hair on top of her head - to one flat, uniform pure magenta "
        "(#FF00FF) with no shading, highlights or lines inside it. Do NOT recolor anything that is not "
        "hair: face, ears, skin, eyes, ribbons, bow, flower ornament, earring, clothes, gloves, book and "
        "the white background must stay exactly as they are.\n"
        "Keep the image pixel-aligned with Image 1: same canvas, same silhouette and position of every "
        "strand; only the hair colour changes."),
    # --- arm variants drawn onto rm_arm_free, so their diff against it is just the arm
    "armf_wave": edit(
        "add back ONLY her left arm (on the viewer's right), raised in a friendly wave: the puffy cream "
        "sleeve starts at her shoulder, the elbow is bent and stays low beside her body, the forearm "
        "points straight up so the open white-gloved hand (palm toward the viewer, fingers together) is "
        "beside her head at about eye height, with the frilled cuff at the wrist. Match her other "
        "sleeve exactly in style and colour: puffy cream sleeve with a small orange flower print, "
        "frilled cuff, white glove, dark brown line art. Keep the white background."),
    "armf_chin": edit(
        "add back ONLY her left arm (on the viewer's right) in a thinking pose: the puffy cream sleeve "
        "starts at her shoulder, the elbow is bent low in front of her waist, and the forearm comes up "
        "across her chest so the tip of her white-gloved index finger rests on her chin, other fingers "
        "loosely curled, frilled cuff at the wrist. Match her other sleeve exactly in style and colour: "
        "puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line "
        "art. Keep her face, expression and the white background unchanged."),
    # --- layer decomposition for the rigged walk pose (all on gen/walk.png, green kept)
    "walk_rm_legs": edit(
        "remove ONLY her two legs and both white lace-up boots below the skirt, as if her legs were "
        "fully hidden under the skirt. Under the frilly petticoat hem, continue the soft pinkish "
        "shadow of the inside of the skirt where the upper legs were, and where the lower legs and "
        "boots were (below the skirt) show the flat chroma-green background. Keep the skirt, every "
        "frill and everything else unchanged.", green=True),
    "walk_rm_arm": edit(
        "remove ONLY her free arm on the viewer's right (the puffy sleeve, frilled cuff and the "
        "white-gloved hand swinging behind her), as if it were hidden behind her back. Where it was, "
        "draw what is behind it: the side of her blouse and dress, the skirt and the long orange "
        "hair, continuing them naturally; where only background was behind it, keep the flat "
        "chroma-green background. Keep the arm holding the book unchanged.", green=True),
    "walk_rm_dangles": edit(
        "remove ONLY the things that hang down: the cream ribbon tails, the gold tassel and orange "
        "cord hanging below her black hair bow, and both dangling tassel earrings. Where they were, "
        "draw the long orange hair, the ears and the face edge behind them, continuing the strands "
        "naturally; where only background was behind them keep the flat chroma-green background. "
        "Keep the black bow knot and the flower ornament.", green=True),
    "walk_seg_hair": (
        "Use case: precise-object-edit (segmentation mask)\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\n"
        "Input images: Image 1: edit target\n"
        "Change: recolor ALL of her hair - the long trailing hair, the bangs, the side locks, the "
        "braid and the hair on top of her head - to one flat, uniform pure magenta (#FF00FF) with no "
        "shading, highlights or lines inside it. Do NOT recolor anything that is not hair: face, "
        "ears, skin, eyes, ribbons, bow, flower ornament, earrings, clothes, gloves, book, boots and "
        "the green background must stay exactly as they are.\n"
        "Keep the image pixel-aligned with Image 1: same canvas, same silhouette and position of "
        "every strand; only the hair colour changes."),
    "walk_seg_legs": (
        "Use case: precise-object-edit (segmentation mask)\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\n"
        "Input images: Image 1: edit target\n"
        "Change: recolor ONLY her two legs below the skirt - the visible parts of both legs and both "
        "white lace-up boots including laces, heels and soles - to one flat, uniform pure blue "
        "(#0000FF) with no shading or lines inside. Do NOT recolor the skirt, the petticoat frills, "
        "the shadow under the skirt, the hair or anything else; the green background stays green.\n"
        "Keep the image pixel-aligned with Image 1: same canvas, same silhouette; only the legs' "
        "colour changes."),
    # --- eyes, bangs, mouths, small dangles on the standing pose
    "rm_bangs": edit(
        "remove ONLY her bangs - the fringe of hair strands hanging over her forehead and in front of "
        "her eyes. Draw what is behind them: her forehead and the complete upper eyelids and eyes, "
        "continuing the skin and the eye shapes naturally, with the hairline higher up at the top of "
        "the forehead. Keep the side locks, the hair on top of her head, the long hair, the eyes' "
        "colours, lashes and expression unchanged."),
    "mouth_a": edit("ONLY her mouth: open wide as when singing a long 'aaa' - a tall rounded open mouth "
                    "with a soft pink tongue and a hint of upper teeth." + " Keep her eyes, eyebrows, blush, bangs and head position unchanged."),
    "mouth_i": edit("ONLY her mouth: a wide flat smile as when saying 'eee' - lips stretched sideways and "
                    "slightly parted, showing a row of white teeth." + " Keep her eyes, eyebrows, blush, bangs and head position unchanged."),
    "mouth_u": edit("ONLY her mouth: a small round pursed mouth as when saying 'oo' - lips pushed "
                    "forward into a tiny round opening." + " Keep her eyes, eyebrows, blush, bangs and head position unchanged."),
    "mouth_e": edit("ONLY her mouth: half open as when saying 'eh' - a wide, medium-open mouth with a "
                    "little pink tongue visible." + " Keep her eyes, eyebrows, blush, bangs and head position unchanged."),
    "mouth_o": edit("ONLY her mouth: a round open 'o' as when saying 'oh' - medium sized, soft pink "
                    "inside." + " Keep her eyes, eyebrows, blush, bangs and head position unchanged."),
    "rm_tassels": edit(
        "remove ONLY the small things that dangle from her dress: the gold tassels hanging below the "
        "two black bows on her skirt, and the orange tassel with the gold chain charm hanging at the "
        "centre of her black corset. Draw the skirt fabric, embroidery and folds that were behind "
        "them, continuing naturally. Keep the bows, the orange flowers on them and everything else."),
    # --- walk: eyes closed for blinking (input: walk)
    "walk_blink": edit(
        "ONLY her eyes: close BOTH eyes completely, as in a blink - the near eye (viewer's left) AND "
        "the far eye (viewer's right, partly behind her bangs) each become a soft downward-curved "
        "closed-eye lash line in the same lash style, with no iris or eye white visible in either eye. "
        "Keep her open happy mouth, blush, bangs, hair, ribbon and head position unchanged.", green=True),
    # --- layer decomposition for the rigged sitting reading pose (input: gen/sit_read.png)
    "sit_seg_hair": (
        "Use case: precise-object-edit (segmentation mask)\\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\\n"
        "Input images: Image 1: edit target\\n"
        "Change: recolor ALL of her hair - the long hair, the bangs, the side locks, the braid and the "
        "hair on top of her head - to one flat, uniform pure magenta (#FF00FF) with no shading, "
        "highlights or lines inside it. Do NOT recolor anything that is not hair: face, ears, skin, "
        "eyes, ribbons, bow, flower ornament, earrings, clothes, gloves, book, boots and the green "
        "background must stay exactly as they are.\\n"
        "Keep the image pixel-aligned with Image 1: same canvas, same silhouette and position of every "
        "strand; only the hair colour changes."),
    "sit_rm_dangles": edit(
        "remove ONLY the things that hang down: the cream ribbon tails, the gold tassel and orange cord "
        "hanging below her black hair bow, and the dangling tassel earrings. Where they were, draw the "
        "long orange hair, the ears and the face edge behind them, continuing the strands naturally; "
        "where only background was behind them keep the flat chroma-green background. Keep the black "
        "bow knot and the flower ornament.", green=True),
    # --- layer decomposition for the rigged dangling pose (input: gen/drag.png)
    "drag_seg_hair": (
        "Use case: precise-object-edit (segmentation mask)\\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\\n"
        "Input images: Image 1: edit target\\n"
        "Change: recolor ALL of her hair - the long hair, the bangs, the side locks, the braid and the "
        "hair on top of her head - to one flat, uniform pure magenta (#FF00FF) with no shading, "
        "highlights or lines inside it. Do NOT recolor anything that is not hair: face, ears, skin, "
        "eyes, ribbons, bow, flower ornament, earrings, clothes, gloves, book, boots and the green "
        "background must stay exactly as they are.\\n"
        "Keep the image pixel-aligned with Image 1: same canvas, same silhouette and position of every "
        "strand; only the hair colour changes."),
    "drag_rm_dangles": edit(
        "remove ONLY the things that hang down: the cream ribbon tails, the gold tassel and orange cord "
        "hanging below her black hair bow, and the dangling tassel earrings. Where they were, draw the "
        "long orange hair, the ears and the face edge behind them, continuing the strands naturally; "
        "where only background was behind them keep the flat chroma-green background. Keep the black "
        "bow knot and the flower ornament.", green=True),
    "drag_seg_legs": (
        "Use case: precise-object-edit (segmentation mask)\\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\\n"
        "Input images: Image 1: edit target\\n"
        "Change: recolor ONLY her two dangling legs below the skirt - the visible parts of both legs and "
        "both white lace-up boots including laces, heels and soles - to one flat, uniform pure blue "
        "(#0000FF) with no shading or lines inside. Do NOT recolor the skirt, the petticoat frills, the "
        "shadow under the skirt, the hair or anything else; the green background stays green.\\n"
        "Keep the image pixel-aligned with Image 1: same canvas, same silhouette; only the legs' colour "
        "changes."),
    "drag_rm_legs": edit(
        "remove ONLY her two dangling legs and both white lace-up boots below the skirt, as if her legs "
        "were fully hidden under the skirt. Under the frilly petticoat hem, continue the soft pinkish "
        "shadow of the inside of the skirt where the upper legs were, and where the lower legs and boots "
        "were (below the skirt) show the flat chroma-green background. Keep the skirt, every frill and "
        "everything else unchanged.", green=True),
    # on rm_bangs: eyes without irises; the irises become their own moving layers
    "eyes_blank": edit(
        "ONLY her eyes: remove the irises, pupils and their highlights from both eyes so that each eye "
        "shows only the plain white of the eye inside the eyelids. Keep the eyelids, the thick dark "
        "upper lashes, the lower lash line and the outline and shape of each eye exactly as they are."),
    "seg_tassels": (
        "Use case: precise-object-edit (segmentation mask)\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\n"
        "Input images: Image 1: edit target\n"
        "Change: recolor ONLY the small things that dangle from her dress to one flat, uniform pure cyan "
        "(#00FFFF) with no shading or lines inside: the two gold tassels hanging below the black bows "
        "on her skirt (each with its little gold cap), and at the centre of her black corset the gold "
        "ring, the small gold chain charm, the two short orange-red cords and the gold tassel hanging "
        "from them. Do NOT recolor the bows, the orange flowers, the skirt panels, the corset, the "
        "chain across the corset or anything else; the white background stays white.\n"
        "Keep the image pixel-aligned with Image 1: same canvas and silhouette; only those dangling "
        "pieces change colour."),
    # --- more free-arm variants for the action library (all drawn onto rm_arm_free)
    "armf_up": edit(
        "add back ONLY her left arm (on the viewer's right), raised straight up above her head as when "
        "eagerly raising a hand or stretching: the puffy sleeve starts at her shoulder, the arm goes up "
        "beside her head with the elbow only slightly bent, the open white-gloved hand high above her "
        "head, palm toward the viewer, fingers together." + ' Match her other sleeve exactly in style and colour: puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line art. Keep her face, eyes, expression, hair and the white background unchanged.'),
    "armf_mouth": edit(
        "add back ONLY her left arm (on the viewer's right), bent so that her white-gloved hand is held "
        "in front of her mouth, fingers together and slightly curled, covering the mouth as when giggling "
        "or politely yawning; the elbow is low beside her body." + ' Match her other sleeve exactly in style and colour: puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line art. Keep her face, eyes, expression, hair and the white background unchanged.'),
    "armf_hip": edit(
        "add back ONLY her left arm (on the viewer's right) with the hand on her hip: the elbow points "
        "out to the side and the back of her white-gloved fist rests on her waist, a proud, confident "
        "pose." + ' Match her other sleeve exactly in style and colour: puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line art. Keep her face, eyes, expression, hair and the white background unchanged.'),
    "armf_point": edit(
        "add back ONLY her left arm (on the viewer's right), stretched out to the side and slightly up, "
        "pointing with the index finger of her white-gloved hand toward the upper right, other fingers "
        "curled, as when saying 'look over there!'." + ' Match her other sleeve exactly in style and colour: puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line art. Keep her face, eyes, expression, hair and the white background unchanged.'),
    "armf_fist": edit(
        "add back ONLY her left arm (on the viewer's right) in a cheerful 'let's do our best!' pose: the "
        "elbow bent and tucked in at her side, a small white-gloved fist raised to shoulder height, "
        "knuckles toward the viewer." + ' Match her other sleeve exactly in style and colour: puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line art. Keep her face, eyes, expression, hair and the white background unchanged.'),
    # --- extra face pieces for actions (edits of chibi_ref)
    "wink": edit(
        "ONLY her left eye (on the viewer's right): close it in a cute playful wink - a happy upward-curved "
        "closed-eye line with the same thick lashes. Her other eye stays open exactly as it is. Mouth, "
        "blush, eyebrows, bangs and head position unchanged."),
    "blush": edit(
        "ONLY her cheeks: a much stronger, rosy pink blush on both cheeks with a few short diagonal shy "
        "lines (anime blush hatching) drawn over each cheek. Eyes, mouth, eyebrows, bangs and everything "
        "else unchanged."),
    # --- page turning while sitting (edits of sit_read)
    "sit_page1": edit(
        "ONLY her hand on the viewer's right and the open book: her gloved fingers lift the corner of the "
        "right-hand page, which curls up a little as she starts to turn it. Everything else unchanged.",
        green=True),
    "sit_page2": edit(
        "ONLY the open book and her hand on the viewer's right: a single page is in the middle of being "
        "turned - it stands up curved above the middle of the book, its top corner held between her "
        "gloved fingertips. Everything else unchanged.", green=True),
    "armf_scratch": edit(
        "add back ONLY her left arm (on the viewer's right), bent up so that the index finger of her white-"
        "gloved hand scratches her cheek just below her ear, an awkward embarrassed gesture; the elbow is "
        "low and out to the side." + ' Match her other sleeve exactly in style and colour: puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line art. Keep her face, eyes, expression, hair and the white background unchanged.'),
    # --- book-arm variants (drawn onto rm_arm_book: her right arm, on the viewer's left)
    "book_hip": edit(
        "add back ONLY her right arm (on the viewer's left) with the hand on her hip, elbow pointing out to "
        "the side and the back of her white-gloved fist resting on her waist, and her brown book tucked "
        "under that arm, pressed between the arm and her side - an indignant hands-on-hips pose." + ' Match her other sleeve exactly in style and colour (puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line art) and keep the book exactly as before: dark brown leather with an orange flower emblem and gold corners. Keep her face, eyes, expression, hair and the white background unchanged.'),
    "book_hug": edit(
        "add back ONLY her right arm (on the viewer's left) hugging her brown book flat against her chest, "
        "the forearm across the book and the white-gloved hand holding its far edge, as when shy or sad."
        + ' Match her other sleeve exactly in style and colour (puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line art) and keep the book exactly as before: dark brown leather with an orange flower emblem and gold corners. Keep her face, eyes, expression, hair and the white background unchanged.'),
    "book_up": edit(
        "add back ONLY her right arm (on the viewer's left) holding her brown book up in front of her face "
        "so that the book covers her mouth and chin while her eyes and nose stay visible above it, as when "
        "hiding shyly behind it; the white-gloved hand holds the book's lower edge." + ' Match her other sleeve exactly in style and colour (puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line art) and keep the book exactly as before: dark brown leather with an orange flower emblem and gold corners. Keep her face, eyes, expression, hair and the white background unchanged.'),
    # --- more faces (edits of chibi_ref)
    "angry": edit(
        "ONLY her facial expression: cute but clearly angry - eyes narrowed into a glare with the upper "
        "lids slanted down toward the nose, a small pouting frown with the lips pushed out, cheeks puffed "
        "with a little blush. Head position, bangs and hair unchanged."),
    "smirk": edit(
        "ONLY her facial expression: a mischievous sly grin - eyes half-closed and narrowed with a playful "
        "glint, the mouth a small one-sided cat-like smile (an 'ω' shape tilted to one side). Head "
        "position, bangs and hair unchanged."),
    "awkward": edit(
        "ONLY her facial expression: an awkward embarrassed smile - eyes looking away to the side, a stiff "
        "wavy forced smile, light blush. Head position, bangs and hair unchanged."),
    "teary": edit(
        "ONLY her facial expression: about to cry - big glistening eyes with tears welling up at the "
        "lower lids, eyebrows raised in the middle, a trembling wavy mouth. Head position, bangs and hair "
        "unchanged."),
    # --- work scene decomposition and variants (all edits of gen/work.png)
    "work_rm_desk": edit(
        "remove ONLY the wooden desk and everything on it (the paper, the open book, the ink pot), as if "
        "they were never there; she keeps sitting on the stool with her arms in the same place, now "
        "holding the quill in the air. Where the desk hid her skirt, legs and hair, draw them naturally; "
        "where only background was behind the desk show the flat chroma-green background.", green=True),
    "work_rm_char": (
        "Use case: precise-object-edit\n"
        "Asset type: background prop layer for a desktop-pet rig; must stay pixel-aligned with Image 1\n"
        "Input images: Image 1: edit target\n"
        "Change: remove the girl completely - her hair, body, clothes, arms and boots - leaving only the "
        "empty wooden stool, the wooden desk and the things on the desk (paper, open book, ink pot) "
        "exactly where they are. Draw the parts of the stool and the desk that she was hiding (the stool "
        "seat and legs, the desk's front edge and legs), and put a quill pen lying on the paper. "
        "Keep the flat chroma-green background and everything else unchanged and pixel-aligned with Image 1."),
    "work_seg_write_arm": (
        "Use case: precise-object-edit (segmentation mask)\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\n"
        "Input images: Image 1: edit target\n"
        "Change: recolor ONLY her writing arm - the arm nearest to the viewer whose hand holds the quill, "
        "from the shoulder down: the puffy sleeve, the frilled cuff, the white glove and the quill pen - to "
        "one flat, uniform pure blue (#0000FF) with no shading or lines inside. Do NOT recolor her other "
        "arm, the paper, the desk, the hair or anything else. Keep the flat chroma-green background and everything else unchanged and pixel-aligned with Image 1."),
    "work_seg_hair": (
        "Use case: precise-object-edit (segmentation mask)\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\n"
        "Input images: Image 1: edit target\n"
        "Change: recolor ALL of her hair - the long hair, the bangs, the side locks, the braid and the hair "
        "on top of her head - to one flat, uniform pure magenta (#FF00FF) with no shading, highlights or "
        "lines inside it. Do NOT recolor anything that is not hair: face, ears, skin, eyes, ribbons, bow, "
        "flower ornament, earrings, clothes, gloves, desk, stool, paper, book, ink pot, boots. Keep the flat chroma-green background and everything else unchanged and pixel-aligned with Image 1."),
    "work_rm_dangles": edit(
        "remove ONLY the things that hang down from her head: the cream ribbon tails, the gold tassel and "
        "the orange cord hanging below her black hair bow, and both dangling tassel earrings. Where they "
        "were, draw the long orange hair, the ears and the face edge behind them, continuing the strands "
        "naturally; where only background was behind them keep the flat chroma-green background. Keep the "
        "black bow knot and the flower ornament.", green=True),
    "work_blink": edit(
        "ONLY her eyes: close both eyes gently, as in a blink - soft downward-curved closed-eye lash lines "
        "in the same lash style. Mouth, blush, bangs and head position unchanged.", green=True),
    "work_think": edit(
        "ONLY her writing arm and her face: she pauses to think - the hand holding the quill is raised so "
        "the feather end of the quill touches her chin, elbow resting on the desk, and her eyes look up "
        "toward the upper right while she purses her lips in thought. Keep the other arm, the paper, the "
        "desk and everything else unchanged.", green=True),
    "work_happy": edit(
        "ONLY her face: eyes closed in happy upward-arched curves and a big open smile, as when she has "
        "just finished writing something she is proud of; light blush. Head position, bangs and hair "
        "unchanged.", green=True),
    "work_rm_arm": edit(
        "remove ONLY her writing arm - the arm nearest to the viewer, from the shoulder down: the puffy "
        "sleeve, the frilled cuff, the white-gloved hand - together with the quill pen it holds, as if "
        "that arm were hidden behind her. Where it was, draw what is behind it: the side of her blouse "
        "and corset, her skirt, and the desk top with the sheet of paper continuing naturally. Keep her "
        "other hand on the paper.", green=True),
    "work_arm_think": edit(
        "add back ONLY her arm nearest to the viewer in a thinking pose: the elbow rests on the desk top "
        "next to the paper, the forearm goes up and the white-gloved hand holds a quill pen with the tip "
        "of its white feather touching her chin. Match her other sleeve exactly in style and colour: "
        "puffy cream sleeve with a small orange flower print, frilled cuff, white glove, dark brown line "
        "art. Keep her face, the paper, the desk and everything else unchanged.", green=True),
    "work_seg_legs": (
        "Use case: precise-object-edit (segmentation mask)\n"
        "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\n"
        "Input images: Image 1: edit target\n"
        "Change: recolor ONLY her two legs below the skirt - the visible parts of both legs and both white "
        "lace-up boots including laces, heels and soles - to one flat, uniform pure blue (#0000FF) with "
        "no shading or lines inside. Do NOT recolor the skirt, the frills, the stool, the desk or "
        "anything else. Keep the flat chroma-green background and everything else unchanged and pixel-aligned with Image 1."),
    "work_rm_legs": edit(
        "remove ONLY her two legs and both white lace-up boots below the skirt, as if her legs were "
        "fully hidden under the skirt. Under the frilly hem continue the soft shadow of the inside of "
        "the skirt; where the lower legs and boots were, show the stool legs and the desk legs that were "
        "behind them, or the flat chroma-green background.", green=True),
    # --- irises for the sitting and working rigs (bangs removed, then irises removed)
    "sit_rm_bangs": edit("remove ONLY her bangs - the fringe of hair strands hanging over her forehead and in front of her eyes. Draw what is behind them: her forehead and the complete upper eyelids and eyes, continuing the skin and the eye shapes naturally, with the hairline higher up at the top of the forehead. Keep the side locks, the hair on top of her head, the long hair, the eyes' colours, lashes and expression unchanged.", green=True),
    "sit_eyes_blank": edit('ONLY her eyes: remove the irises, pupils and their highlights from both eyes so that each eye shows only the plain white of the eye inside the eyelids. Keep the eyelids, the thick dark upper lashes, the lower lash line and the outline and shape of each eye exactly as they are.', green=True),
    "work_rm_bangs": edit("remove ONLY her bangs - the fringe of hair strands hanging over her forehead and in front of her eyes. Draw what is behind them: her forehead and the complete upper eyelids and eyes, continuing the skin and the eye shapes naturally, with the hairline higher up at the top of the forehead. Keep the side locks, the hair on top of her head, the long hair, the eyes' colours, lashes and expression unchanged.", green=True),
    "work_eyes_blank": edit('ONLY her eyes: remove the irises, pupils and their highlights from both eyes so that each eye shows only the plain white of the eye inside the eyelids. Keep the eyelids, the thick dark upper lashes, the lower lash line and the outline and shape of each eye exactly as they are.', green=True),
    # --- new poses
    "work": pose(
        "the same chibi girl at work: she sits on a tall round wooden stool at a small wooden writing "
        "desk, in a three-quarter view facing the right side of the image. The desk stands on the right "
        "and she faces it, writing on a sheet of paper on the desk with a quill pen held in the hand "
        "nearest to the viewer, her forearm resting on the desk top; her other hand holds the paper. "
        "Her brown leather book with the orange flower emblem lies open on the desk next to the paper, "
        "with a small glass ink pot. Her legs dangle from the stool, boots not touching the floor, the "
        "layered skirt draped over the stool. Focused, content expression, eyes on the paper. The stool "
        "has three straight legs; the desk has four legs and a plain top. The desk, the stool and "
        "everything on the desk must be fully inside the canvas. No floor line, no rug, no cast "
        "shadows."),
    "drag": pose(
        "the same chibi girl dangling in mid-air as if a giant hand has just picked her up by the "
        "back of her collar: front view, body hanging straight down, both legs dangling loosely "
        "with the boots pointing down, the book hugged to her chest with both arms, flustered "
        "surprised expression (wide eyes, small open 'o' mouth, blush). Her very long hair and the "
        "layered skirt hang straight down with gravity. No hand or hook visible."),
    "sit_read": pose(
        "the same chibi girl sitting on the floor with her legs folded to one side, the layered "
        "skirt spread around her on the ground and the boot tips peeking out, holding the open book "
        "with both hands in her lap and reading it - eyes looking down at the pages, calm content "
        "smile. Her long hair pools on the floor around her. Front three-quarter view."),
    "walk": pose(
        "the same chibi girl walking toward the right side of the image in a three-quarter view: "
        "a light, cheerful mid-stride step with one boot lifted, the book tucked under her arm, the "
        "other arm swinging slightly, happy expression, hair and skirt trailing slightly behind her."),
    "cheer": pose(
        "the same chibi girl jumping up with joy, both boots off the ground with the knees bent "
        "back, her free arm thrown up in the air, the book held in the other hand, eyes closed in "
        "happy ^ ^ curves and a big open smile, her hair and layered skirt flaring up and outward. "
        "Front view."),
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, text in PROMPTS.items():
        (OUT / f"{name}.txt").write_text(text + "\n")
    print(f"wrote {len(PROMPTS)} prompts to {OUT}")


if __name__ == "__main__":
    main()
