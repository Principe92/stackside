import type { ClientModule } from 'claude-code'

// A transparent region laid over the page picture: a click posts where it
// landed, as fractions of the region, and the hooks module clicks there.
type Props = { hint: string }
type State = { armed: true }

const ClickPad: ClientModule<Props, State> = (props, surface) => {
  if (!surface.state) {
    surface.onPointer(ev => {
      if (ev.type !== 'up' || ev.button !== 'left') return
      const cols = Math.max(1, surface.columns)
      const rows = Math.max(1, surface.rows)
      const x = (ev.fine?.x ?? ev.x + 0.5) / cols
      const y = (ev.fine?.y ?? ev.y + 0.5) / rows
      if (x < 0 || y < 0 || x > 1 || y > 1) return
      surface.post({ kind: 'click', fx: x, fy: y })
    })
    surface.onKey(ev => {
      surface.post({ kind: 'key', key: ev.key, ctrl: ev.ctrl ?? false, shift: ev.shift ?? false })
    })
    surface.setState({ armed: true })
  }
  const { Box, Text } = surface.elements
  return (
    <Box width="100%" height="100%">
      <Text dimColor> </Text>
    </Box>
  )
}

export default ClickPad
