--!nonstrict
-- Blinking red dot; the panel-open context is an optional message shown on hover.

local HALF_MS = 231
local LOW = 0.15
local SIZE = 20

local phase = 0
local message = ""

-- InOutSine from 1 down to LOW, then back up, HALF_MS each way.
local function opacityAt(t)
  local p = (t % HALF_MS) / HALF_MS
  local eased = (1 - math.cos(math.pi * p)) / 2
  if t < HALF_MS then
    return 1 - (1 - LOW) * eased
  end
  return LOW + (1 - LOW) * eased
end

local function render()
  panel.render(ui.column({ flexGrow = 1, align = "center", justify = "center" }, {
    ui.box({
      width = SIZE,
      height = SIZE,
      radius = SIZE / 2,
      fill = "#ff3333",
      opacity = opacityAt(phase),
      tooltip = message ~= "" and message or nil,
    }),
  }))
end

function onOpen(context)
  message = noctalia.string.trim(context or "")
  phase = 0
  render()
  panel.setNeedsFrameTick(true)
end

function onClose()
  panel.setNeedsFrameTick(false)
  message = ""
end

function onFrameTick(deltaMs)
  phase = (phase + (tonumber(deltaMs) or 16)) % (2 * HALF_MS)
  render()
end
