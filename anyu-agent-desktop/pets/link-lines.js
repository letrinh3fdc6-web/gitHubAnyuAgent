'use strict'
window.pet.onEvent(event => {
  if (event.type !== 'link-lines') return
  const svg = document.querySelector('svg'), ns = 'http://www.w3.org/2000/svg'
  svg.replaceChildren()
  for (const segment of event.lines) {
    const line = document.createElementNS(ns, 'line')
    for (const key of ['x1', 'y1', 'x2', 'y2']) line.setAttribute(key, segment[key])
    line.setAttribute('stroke', segment.color); svg.append(line)
    for (const point of [1, 2]) {
      const dot = document.createElementNS(ns, 'circle')
      dot.setAttribute('cx', segment[`x${point}`]); dot.setAttribute('cy', segment[`y${point}`]); dot.setAttribute('fill', segment.color); svg.append(dot)
    }
  }
})
