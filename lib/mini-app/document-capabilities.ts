/** Lightweight source of truth shared by authoring instructions and compilation. */
export const MINI_APP_HTML_TAGS = "main header footer section article div span p h1 h2 h3 h4 strong em b i code pre small ul ol li table thead tbody tr th td caption label input select option button output canvas br hr".split(" ");
export const MINI_APP_CSS_PROPERTIES = `display flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content justify-items justify-self gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row grid-auto-flow
position top right bottom left width min-width max-width height min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left
color background background-color border border-width border-color border-style border-top border-bottom border-left border-right border-radius border-collapse border-spacing
font font-size font-weight font-style letter-spacing word-spacing line-height text-align text-decoration white-space overflow-wrap word-break vertical-align opacity overflow overflow-x overflow-y box-sizing cursor user-select touch-action outline outline-offset
fill stroke stroke-width list-style list-style-type list-style-position`.split(/\s+/);
