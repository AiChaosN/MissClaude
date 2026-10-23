#!/usr/bin/env python3
"""Prompt specs for the dachshund (lachang) pack's generated art.

Writes one text file per asset into art/lachang/prompts/. Everything is derived
from the one reference drawing (art/lachang/source/dachshund_ref.png): first a
chroma-green re-render of it (base_green, for matting), then pixel-aligned edits of
that render (segmentation recolours, part removals, faces), and new poses drawn with
the dog as the character reference.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "art" / "lachang" / "prompts"

GREEN_BG = (
    "Background: a perfectly flat, uniform chroma-key green (#00FF00) filling the entire canvas "
    "edge to edge - no gradient, no floor, no cast shadow, no decorations, no text, no watermark. "
    "Keep the dog's fur edges crisp against it, with no green spill or glow on the dog."
)

KEEP_ALL = (
    "Keep everything else exactly identical to Image 1 and pixel-aligned with it: same canvas size, "
    "framing, position and scale of the dog, same pose, fur strokes, colours, shading and the flat "
    "green background."
)

DOG = (
    "Character lock (do not redesign the dog): the exact same long-haired chocolate-and-tan "
    "dachshund puppy as Image 1 - dark chocolate-brown silky coat with warm tan/orange markings on "
    "the muzzle, above the eyes, on the chest, the legs and the paws; very long, wavy, feathered "
    "ears hanging down beside the head; big round dark-brown eyes with bright white highlights; a "
    "dark brown nose; a long, low sausage body on short legs; a long feathered tail. Same "
    "semi-realistic illustrated style with soft painted fur strokes and warm lighting as Image 1."
)

COMPOSE = (
    "Composition: square 1:1 canvas, the whole dog visible and centered, nothing cropped (ears, tail "
    "and paws inside the frame with a small margin). Draw the dog at the same scale as in Image 1 - "
    "its head the same size."
)

SEG_HEAD = (
    "Use case: precise-object-edit (segmentation mask)\n"
    "Asset type: segmentation mask for a desktop-pet rig; must stay pixel-aligned with Image 1\n"
    "Input images: Image 1: edit target\n"
)


def edit(change: str) -> str:
    return "\n".join([
        "Use case: identity-preserve / precise-object-edit",
        "Asset type: animation frame for a desktop-pet sprite (frames are swapped at runtime, so "
        "alignment with Image 1 matters)",
        "Input images: Image 1: edit target",
        f"Change: {change}",
        KEEP_ALL,
    ])


def seg(change: str) -> str:
    return SEG_HEAD + (
        f"Change: {change} Use one flat, uniform colour with no shading, highlights, fur strokes or "
        "lines inside the recoloured area, and a clean edge that follows the fur silhouette exactly. "
        "Do NOT recolor anything else; the rest of the dog and the green background stay exactly as "
        "they are.\n"
        "Keep the image pixel-aligned with Image 1: same canvas, same silhouette and position of "
        "everything; only the colour of the named part changes."
    )


def pose(request: str) -> str:
    return "\n".join([
        "Use case: identity-preserve (same character, new pose)",
        "Asset type: desktop-pet sprite (will be chroma-keyed to transparency)",
        "Input images: Image 1: character reference (breed, colours, fur, face, art style)",
        f"Primary request: {request}",
        COMPOSE,
        GREEN_BG,
        DOG,
    ])


FACE_KEEP = (
    " Keep the head position, the ears, the nose, the fur and everything else unchanged; only the "
    "named part of the face changes."
)

PROMPTS = {
    # --- canonical base: only the background changes, used to derive the alpha mask
    "base_green": (
        "Use case: background-extraction\n"
        "Asset type: desktop-pet sprite source (will be chroma-keyed to transparency)\n"
        "Input images: Image 1: edit target\n"
        "Change: replace ONLY the background. " + GREEN_BG + " Also remove the soft shadow on the "
        "ground under the dog.\n"
        "The dog must stay 100% unchanged and pixel-aligned with Image 1: identical pose, position, "
        "scale, silhouette, fur strokes, colours and shading, every strand of the ears and tail."
    ),
    # --- segmentation recolours and removals on base_green: the rig's layers
    "seg_ears": seg(
        "recolor BOTH ears - the whole of each long feathered ear, from where it joins the top of the "
        "head down to the tips of the wavy fringe - to pure magenta (#FF00FF)."),
    "rm_ears": edit(
        "remove BOTH ears completely, as if the dog had no ears. Where they were, draw what is behind "
        "them: the side of the head, the neck and the chest fur continuing naturally in the same "
        "colours and fur strokes (a smooth rounded head without ear flaps); where only background was "
        "behind them show the flat chroma-green background."),
    "seg_tail": seg(
        "recolor the tail - the whole feathered tail from where it leaves the rump to its tip - to "
        "pure cyan (#00FFFF)."),
    "rm_tail": edit(
        "remove the tail completely, as if the dog had no tail. Where it was, draw what is behind it: "
        "the rounded rump and hind leg fur continuing naturally in the same colours and strokes; "
        "where only background was behind it show the flat chroma-green background."),
    "seg_legs": seg(
        "recolor all FOUR legs - each leg from where it leaves the body down to and including its paw "
        "and claws - to pure blue (#0000FF). The body, chest and belly fur above the legs stay as "
        "they are."),
    "rm_legs": edit(
        "remove all FOUR legs and paws completely, as if the dog's body were floating with no legs. "
        "Where the legs joined the body, continue the chest and belly fur naturally into a smooth, "
        "rounded underside in the same colours and strokes; where only background was behind the "
        "legs show the flat chroma-green background."),
    "eyes_blank": edit(
        "ONLY the eyes: remove the irises and pupils from both eyes, leaving each eye as a plain, "
        "evenly white eyeball of the same shape and size, with the same dark eyelid edges and the "
        "same fur around it. No iris, no pupil, no highlight." + FACE_KEEP),
    # --- faces (patches are cut out of these)
    "blink": edit(
        "ONLY the eyes: both eyes closed, each a gentle downward-curving dark line of closed eyelids "
        "with the fur around them, as in the middle of a blink." + FACE_KEEP),
    "eyes_half": edit(
        "ONLY the eyes: both eyes half-closed, the upper eyelids lowered to cover the upper half of "
        "each eye, sleepy." + FACE_KEEP),
    "look_left": edit(
        "ONLY the eyes: both irises and pupils moved to the viewer's LEFT edge of the eyes, as if the "
        "dog glances sideways to its right; eye shapes, highlights and eyelids unchanged." + FACE_KEEP),
    "look_right": edit(
        "ONLY the eyes: both irises and pupils moved to the viewer's RIGHT edge of the eyes, as if the "
        "dog glances sideways to its left; eye shapes, highlights and eyelids unchanged." + FACE_KEEP),
    "happy": edit(
        "ONLY the face: a happy expression - both eyes closed into upward-curving smiling arcs, the "
        "mouth open in a wide smile with the pink tongue hanging out." + FACE_KEEP),
    "tongue": edit(
        "ONLY the mouth: the mouth open in a relaxed pant with the pink tongue hanging out over the "
        "lower jaw; eyes unchanged." + FACE_KEEP),
    "surprised": edit(
        "ONLY the face: a startled expression - both eyes opened extra wide and round with small "
        "pupils, the mouth a small open 'o'." + FACE_KEEP),
    "sad": edit(
        "ONLY the face: a sad puppy-dog expression - the eyes big and glossy with a tear welling in "
        "each, the eyebrows (the tan spots above the eyes) tilted up toward the middle, the mouth "
        "closed and turned down." + FACE_KEEP),
    "angry": edit(
        "ONLY the face: an angry growl - the eyebrows (the tan spots above the eyes) lowered and "
        "pulled toward the middle, the eyes narrowed, the muzzle wrinkled and the mouth open showing "
        "small white teeth." + FACE_KEEP),
    "wink": edit(
        "ONLY the eyes: the dog's eye on the viewer's right closed in a wink (a single curved dark "
        "line of closed eyelids); the other eye unchanged." + FACE_KEEP),
    "mouth_open": edit(
        "ONLY the mouth: the mouth open wide as if barking - the lower jaw dropped, a rounded open "
        "mouth showing the pink inside and the tongue, small white teeth at the top; eyes unchanged."
        + FACE_KEEP),
    "mouth_half": edit(
        "ONLY the mouth: the mouth slightly open, lips parted a little showing a hint of the pink "
        "tongue, as if about to speak; eyes unchanged." + FACE_KEEP),
    "smirk": edit(
        "ONLY the face: a sly, mischievous look - the eyes half-closed and glancing to the viewer's "
        "right, one eyebrow (tan spot) raised, the mouth closed in a lopsided grin pulled up on one "
        "side." + FACE_KEEP),
    # --- new poses (whole sprites, chroma green)
    "drag": pose(
        "The same dachshund dangling in mid-air, held up by the loose skin at the back of its neck "
        "(as if a hand had picked it up by the scruff - but draw NO hand, nothing holds it visibly): "
        "the long body hangs straight down vertically, head at the top looking at the viewer with a "
        "mildly alarmed expression, all four legs dangling limply below the body, the long ears "
        "hanging down beside the face, the tail hanging down. Front three-quarter view."),
    "sit": pose(
        "The same dachshund sitting on its haunches, facing the viewer in a three-quarter view: the "
        "hind legs folded under, the front legs straight and planted together in front of the chest, "
        "the long ears hanging beside the face, the tail resting on the floor beside it curling out "
        "to the side, the head up looking at the viewer with a friendly, attentive expression and the "
        "mouth closed."),
    "sleep": pose(
        "The same dachshund lying on the floor fast asleep, curled into a loose crescent on its side: "
        "the head resting on its front paws, both eyes closed in relaxed curved lines, the mouth "
        "closed and peaceful, the long ears spread out softly on the floor, the tail curled around "
        "toward the nose. Seen from slightly above and the side, three-quarter view."),
    "beg": pose(
        "The same dachshund sitting up on its hind legs 'begging': the upright body balanced on the "
        "folded hind legs, both front paws raised together in front of the chest, the head up with "
        "big hopeful eyes looking at the viewer, the ears hanging down, the tail on the floor behind "
        "it. Front three-quarter view."),
    "lie": pose(
        "The same dachshund lying flat on its belly on the floor, facing the viewer in a "
        "three-quarter view: the chin resting on the floor between its outstretched front paws, "
        "the hind legs tucked beside the body, the ears spread out on the floor, the eyes open and "
        "looking up at the viewer with a bored, sulky expression, the tail lying out behind."),
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, text in PROMPTS.items():
        (OUT / f"{name}.txt").write_text(text.strip() + "\n")
    print(f"wrote {len(PROMPTS)} prompts to {OUT}")


if __name__ == "__main__":
    main()
