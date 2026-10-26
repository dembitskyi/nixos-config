--!nonstrict
-- Lock-screen greeting card: avatar, welcome line, date and a digital clock inside a seconds ring.

local CLOCK = 70
local RING_RADIUS = 32
local RING_WIDTH = 2.5

local user = noctalia.getenv("USER") or ""
local avatar = noctalia.getSetting("shell.avatar_path")
local dir = noctalia.pluginDataDir()
local flip = false

local function color(role, fallback)
  return noctalia.getColor(role) or fallback
end

-- The UI tree has no arcs, so the ring and digits are an SVG file drawn each second.
local function clockSvg()
  local c = CLOCK / 2
  local seconds = tonumber(noctalia.formatTime("{:%S}")) or 0
  local angle = seconds / 60 * 2 * math.pi
  local x = c + RING_RADIUS * math.sin(angle)
  local y = c - RING_RADIUS * math.cos(angle)
  local text = color("on_surface", "#ffffff")
  local arc = ""
  if seconds > 0 then
    arc = string.format(
      '<path d="M %g %g A %g %g 0 %d 1 %.2f %.2f" fill="none" stroke="%s" stroke-width="%g" stroke-linecap="round"/>',
      c, c - RING_RADIUS, RING_RADIUS, RING_RADIUS, seconds > 30 and 1 or 0, x, y, color("primary", "#e6b450"), RING_WIDTH
    )
  end
  local digits = string.format(
    '<text x="%g" y="%g" text-anchor="middle" font-family="monospace" font-weight="bold" font-size="17" fill="%s">%s</text>',
    c, c - 2, text, noctalia.formatTime("{:%H}")
  ) .. string.format(
    '<text x="%g" y="%g" text-anchor="middle" font-family="monospace" font-weight="bold" font-size="17" fill="%s">%s</text>',
    c, c + 15, text, noctalia.formatTime("{:%M}")
  )
  local svg = string.format(
    '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">'
      .. '<circle cx="%g" cy="%g" r="%g" fill="none" stroke="%s" stroke-opacity="0.15" stroke-width="%g"/>%s%s</svg>',
    CLOCK, CLOCK, c, c, RING_RADIUS, text, RING_WIDTH, arc, digits
  )
  -- Images reload by path, so two files alternate.
  flip = not flip
  local path = dir .. "/clock-" .. (flip and "a" or "b") .. ".svg"
  return noctalia.writeFile(path, svg) and path or nil
end

local function render()
  local children = {}
  if type(avatar) == "string" and avatar ~= "" then
    table.insert(children, ui.row({ key = "avatar", width = 70, height = 70, radius = 35, border = "primary/0.8", borderWidth = 2, align = "center", justify = "center" }, {
      ui.image({ path = avatar, width = 66, height = 66, radius = 33, fit = "cover" }),
    }))
  end
  table.insert(children, ui.column({ key = "text", gap = 2, flexGrow = 1 }, {
    ui.label({ text = "Welcome back, " .. user .. "!", fontSize = 24, color = "on_surface" }),
    ui.label({ text = noctalia.formatTime("{:%A, %B %-d}"), fontSize = 21, color = "on_surface_variant" }),
  }))
  local clock = dir and clockSvg()
  if clock then
    table.insert(children, ui.image({ key = "clock", path = clock, width = CLOCK, height = CLOCK }))
  end
  desktopWidget.render(ui.row({ padding = 25, gap = 36, minWidth = 500, align = "center", fill = "surface", radius = 6, border = "outline/0.2", borderWidth = 1 }, children))
end

function update()
  render()
end

noctalia.setUpdateInterval(1000)
render()
