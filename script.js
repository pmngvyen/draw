        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        
        let drawing = false;
        let currentTool = 'pen';
        let penColor = 'black';
        let penSize = 3;
        let highlighterColor = 'yellow';
        let highlighterSize = 30;
        let highlighterOpacity = 0.3;
        let currentStroke = [];
        let strokes = [];
        let redoStack = [];
        let lastPenClick = 0;
        let lastHighlighterClick = 0;
        let smoothingBuffer = [];
        let drawStartTime = 0;
        let isHolding = false;
        let straightLineTimeout = null;
        let textInput = document.getElementById('textInput');
        let textHandle = document.getElementById('textHandle');
        let isEditingText = false;
        let currentTextStroke = null;
        let isDraggingText = false;
        let textFont = 'Arial';
        let textSize = 20;
        let selectedTextIndex = -1;
        let isDraggingFinalizedText = false;
        let dragOffset = { x: 0, y: 0 };
        let lastTextClick = 0;
        let lastClickedTextIndex = -1;
        let eraserMode = 'stroke'; // 'stroke' or 'pixel'
        let lastEraserPos = null; // Track last eraser position for smooth erasing
        let currentEraseStroke = null; // Current pixel erase stroke being drawn
        
        window.addEventListener('resize', () => {
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            ctx.putImageData(imgData, 0, 0);
        });
        
        function isPointInStroke(x, y, stroke) {
            // Much more generous threshold for instant eraser response
            const baseThreshold = stroke.tool === 'highlighter' ? stroke.size * 1.5 : stroke.size * 3;
            
            // Check against each point in the stroke
            for (let i = 0; i < stroke.points.length; i++) {
                const p = stroke.points[i];
                const distance = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2);
                if (distance < baseThreshold) {
                    return true;
                }
            }
            
            // Also check between points for better coverage
            for (let i = 0; i < stroke.points.length - 1; i++) {
                const p1 = stroke.points[i];
                const p2 = stroke.points[i + 1];
                
                // Calculate distance from point to line segment
                const lineLength = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
                if (lineLength === 0) continue;
                
                const t = Math.max(0, Math.min(1, ((x - p1.x) * (p2.x - p1.x) + (y - p1.y) * (p2.y - p1.y)) / (lineLength * lineLength)));
                const projX = p1.x + t * (p2.x - p1.x);
                const projY = p1.y + t * (p2.y - p1.y);
                const distanceToLine = Math.sqrt((x - projX) ** 2 + (y - projY) ** 2);
                
                if (distanceToLine < baseThreshold) {
                    return true;
                }
            }
            
            return false;
        }
        
        function startDrawing(e) {
            if (currentTool === 'text') {
                const pos = getMousePos(e);
                const rect = canvas.getBoundingClientRect();
                const now = Date.now();
                
                // Check if clicking on existing text
                for (let i = strokes.length - 1; i >= 0; i--) {
                    const stroke = strokes[i];
                    if (stroke.tool === 'text') {
                        ctx.font = `${stroke.size}px ${stroke.font}`;
                        const textWidth = ctx.measureText(stroke.text).width;
                        const textHeight = stroke.size;
                        
                        if (pos.x >= stroke.x && pos.x <= stroke.x + textWidth &&
                            pos.y >= stroke.y && pos.y <= stroke.y + textHeight) {
                            
                            // Check for double-click
                            if (now - lastTextClick < 500 && lastClickedTextIndex === i) {
                                // Double-click detected - edit text
                                editExistingText(stroke, i, rect);
                                lastTextClick = 0;
                                lastClickedTextIndex = -1;
                                return;
                            }
                            
                            // Single click - prepare to drag
                            lastTextClick = now;
                            lastClickedTextIndex = i;
                            selectedTextIndex = i;
                            isDraggingFinalizedText = true;
                            dragOffset.x = pos.x - stroke.x;
                            dragOffset.y = pos.y - stroke.y;
                            return;
                        }
                    }
                }
                
                // No text clicked, place new text box
                lastTextClick = 0;
                lastClickedTextIndex = -1;
                placeTextBox(e, rect);
                return;
            }
            
            drawing = true;
            smoothingBuffer = [];
            drawStartTime = Date.now();
            isHolding = false;
            clearTimeout(straightLineTimeout);
            
            if (currentTool === 'eraser') {
                if (eraserMode === 'stroke') {
                    const pos = getMousePos(e);
                    for (let i = strokes.length - 1; i >= 0; i--) {
                        if (isPointInStroke(pos.x, pos.y, strokes[i])) {
                            redoStack = [];
                            strokes.splice(i, 1);
                            redrawCanvas();
                            break;
                        }
                    }
                } else {
                    // Pixel eraser - start a new erase stroke
                    const pos = getMousePos(e);
                    drawing = true;
                    lastEraserPos = pos;
                    currentEraseStroke = {
                        tool: 'pixelErase',
                        points: [pos]
                    };
                    
                    // Draw the initial erase point
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.lineWidth = 20;
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, 10, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalCompositeOperation = 'source-over';
                }
                return;
            }
            
            currentStroke = {
                tool: currentTool,
                color: currentTool === 'pen' ? penColor : highlighterColor,
                size: currentTool === 'pen' ? penSize : highlighterSize,
                opacity: currentTool === 'highlighter' ? highlighterOpacity : 1,
                points: []
            };
            const pos = getMousePos(e);
            smoothingBuffer.push(pos);
            currentStroke.points.push(pos);
            
            // Set timeout to detect if user is holding still
            straightLineTimeout = setTimeout(() => {
                if (drawing && currentStroke.points.length > 1) {
                    isHolding = true;
                    convertToStraightLine();
                }
            }, 400);
        }
        
        function draw(e) {
            if (!drawing && !isDraggingFinalizedText) return;
            
            const pos = getMousePos(e);
            
            // Handle dragging finalized text
            if (isDraggingFinalizedText && selectedTextIndex >= 0) {
                strokes[selectedTextIndex].x = pos.x - dragOffset.x;
                strokes[selectedTextIndex].y = pos.y - dragOffset.y;
                redrawCanvas();
                return;
            }
            
            // Reset timer if user is still moving
            if (!isHolding) {
                clearTimeout(straightLineTimeout);
                straightLineTimeout = setTimeout(() => {
                    if (drawing && currentStroke.points.length > 1) {
                        isHolding = true;
                        convertToStraightLine();
                    }
                }, 400);
            }
            
            if (currentTool === 'eraser') {
                if (eraserMode === 'stroke') {
                    // Stroke eraser - erase entire strokes
                    let anyErased = false;
                    for (let i = strokes.length - 1; i >= 0; i--) {
                        if (isPointInStroke(pos.x, pos.y, strokes[i])) {
                            strokes.splice(i, 1);
                            anyErased = true;
                        }
                    }
                    if (anyErased) {
                        redoStack = [];
                        redrawCanvas();
                    }
                } else {
                    // Pixel eraser - add points to erase stroke
                    if (currentEraseStroke) {
                        currentEraseStroke.points.push(pos);
                    }
                    
                    // Draw continuous eraser line for smooth erasing
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.lineWidth = 20;
                    
                    if (lastEraserPos) {
                        ctx.beginPath();
                        ctx.moveTo(lastEraserPos.x, lastEraserPos.y);
                        ctx.lineTo(pos.x, pos.y);
                        ctx.stroke();
                    }
                    
                    lastEraserPos = pos;
                    ctx.globalCompositeOperation = 'source-over';
                }
                return;
            }
            
            if (isHolding) {
                // Update the endpoint of the straight line
                currentStroke.points[1] = pos;
                redrawCanvas();
                drawStroke(currentStroke);
                return;
            }
            
            // Add smoothing for pen tool only
            if (currentTool === 'pen') {
                smoothingBuffer.push(pos);
                
                // Keep buffer small for slight lag effect
                if (smoothingBuffer.length > 3) {
                    smoothingBuffer.shift();
                }
                
                // Calculate smoothed position (average of recent points)
                let smoothedX = 0;
                let smoothedY = 0;
                for (let i = 0; i < smoothingBuffer.length; i++) {
                    smoothedX += smoothingBuffer[i].x;
                    smoothedY += smoothingBuffer[i].y;
                }
                smoothedX /= smoothingBuffer.length;
                smoothedY /= smoothingBuffer.length;
                
                currentStroke.points.push({ x: smoothedX, y: smoothedY });
            } else {
                currentStroke.points.push(pos);
            }
            
            redrawCanvas();
            drawStroke(currentStroke);
        }
        
        function stopDrawing() {
            if (isDraggingFinalizedText) {
                isDraggingFinalizedText = false;
                selectedTextIndex = -1;
                return;
            }
            
            if (!drawing) return;
            drawing = false;
            clearTimeout(straightLineTimeout);
            
            // Save pixel erase stroke
            if (currentTool === 'eraser' && eraserMode === 'pixel' && currentEraseStroke) {
                strokes.push(currentEraseStroke);
                redoStack = [];
                currentEraseStroke = null;
                lastEraserPos = null;
                return;
            }
            
            if (currentTool !== 'eraser' && currentStroke.points.length > 0) {
                strokes.push(currentStroke);
                redoStack = [];
            }
            
            isHolding = false;
        }
        
        function getMousePos(e) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (e.clientX || e.touches[0].clientX) - rect.left,
                y: (e.clientY || e.touches[0].clientY) - rect.top
            };
        }
        
        function convertToStraightLine() {
            if (currentStroke.points.length < 2) return;
            
            const startPoint = currentStroke.points[0];
            const endPoint = currentStroke.points[currentStroke.points.length - 1];
            
            // Calculate distance
            const distance = Math.sqrt(
                Math.pow(endPoint.x - startPoint.x, 2) + 
                Math.pow(endPoint.y - startPoint.y, 2)
            );
            
            // Replace all points with just start and end for a perfect straight line
            currentStroke.points = [startPoint, endPoint];
            
            redrawCanvas();
            drawStroke(currentStroke);
        }
        
        function placeTextBox(e, rect) {
            const pos = getMousePos(e);
            
            textInput.style.left = (rect.left + pos.x) + 'px';
            textInput.style.top = (rect.top + pos.y) + 'px';
            textInput.style.display = 'block';
            textInput.style.fontSize = textSize + 'px';
            textInput.style.fontFamily = textFont;
            textInput.style.color = penColor;
            textInput.style.width = 'auto';
            textInput.style.height = 'auto';
            textInput.value = '';
            isEditingText = true;
            currentTextStroke = null;
            
            // Position handle
            textHandle.style.display = 'block';
            textHandle.style.left = (rect.left + pos.x - 10) + 'px';
            textHandle.style.top = (rect.top + pos.y - 10) + 'px';
            
            setTimeout(() => {
                textInput.focus();
            }, 10);
        }
        
        function editExistingText(stroke, index, rect) {
            textInput.style.left = (rect.left + stroke.x) + 'px';
            textInput.style.top = (rect.top + stroke.y) + 'px';
            textInput.style.display = 'block';
            textInput.style.fontSize = stroke.size + 'px';
            textInput.style.fontFamily = stroke.font;
            textInput.style.color = stroke.color;
            textInput.value = stroke.text;
            isEditingText = true;
            currentTextStroke = { stroke, index };
            
            // Position handle
            textHandle.style.display = 'block';
            textHandle.style.left = (rect.left + stroke.x - 10) + 'px';
            textHandle.style.top = (rect.top + stroke.y - 10) + 'px';
            
            setTimeout(() => {
                textInput.focus();
                textInput.select();
            }, 10);
        }
        
        function finalizeText() {
            if (!isEditingText || !textInput.value.trim()) {
                textInput.style.display = 'none';
                textHandle.style.display = 'none';
                isEditingText = false;
                currentTextStroke = null;
                return;
            }
            
            const rect = canvas.getBoundingClientRect();
            const x = parseInt(textInput.style.left) - rect.left;
            const y = parseInt(textInput.style.top) - rect.top;
            
            if (currentTextStroke) {
                // Update existing text
                strokes[currentTextStroke.index] = {
                    tool: 'text',
                    color: textInput.style.color,
                    size: parseInt(textInput.style.fontSize),
                    font: textInput.style.fontFamily,
                    text: textInput.value,
                    x: x,
                    y: y
                };
            } else {
                // Create new text
                strokes.push({
                    tool: 'text',
                    color: penColor,
                    size: textSize,
                    font: textFont,
                    text: textInput.value,
                    x: x,
                    y: y
                });
                redoStack = [];
            }
            
            redrawCanvas();
            textInput.style.display = 'none';
            textHandle.style.display = 'none';
            textInput.value = '';
            isEditingText = false;
            currentTextStroke = null;
        }
        
        // Text dragging
        textHandle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            isDraggingText = true;
        });
        
        document.addEventListener('mousemove', (e) => {
            if (isDraggingText && isEditingText) {
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - 10;
                const y = e.clientY - 10;
                
                textHandle.style.left = x + 'px';
                textHandle.style.top = y + 'px';
                textInput.style.left = (x + 10) + 'px';
                textInput.style.top = (y + 10) + 'px';
            }
        });
        
        document.addEventListener('mouseup', () => {
            isDraggingText = false;
        });
        
        textInput.addEventListener('blur', finalizeText);
        textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                finalizeText();
            } else if (e.key === 'Escape') {
                textInput.style.display = 'none';
                textInput.value = '';
                isEditingText = false;
            }
        });
        
        function drawStroke(stroke) {
            if (stroke.tool === 'text') {
                ctx.font = `${stroke.size}px ${stroke.font}`;
                ctx.fillStyle = stroke.color;
                ctx.textBaseline = 'top';
                ctx.fillText(stroke.text, stroke.x, stroke.y);
                return;
            }
            
            if (stroke.tool === 'pixelErase') {
                // Draw erase stroke
                ctx.globalCompositeOperation = 'destination-out';
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.lineWidth = 20;
                
                if (stroke.points.length > 1) {
                    ctx.beginPath();
                    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
                    for (let i = 1; i < stroke.points.length; i++) {
                        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
                    }
                    ctx.stroke();
                }
                
                ctx.globalCompositeOperation = 'source-over';
                return;
            }
            
            if (stroke.points.length < 2) return;
            
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = stroke.opacity;
            ctx.lineWidth = stroke.size;
            ctx.strokeStyle = stroke.color;
            
            ctx.beginPath();
            ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
            
            for (let i = 1; i < stroke.points.length - 1; i++) {
                const xc = (stroke.points[i].x + stroke.points[i + 1].x) / 2;
                const yc = (stroke.points[i].y + stroke.points[i + 1].y) / 2;
                ctx.quadraticCurveTo(stroke.points[i].x, stroke.points[i].y, xc, yc);
            }
            
            if (stroke.points.length > 1) {
                const lastPoint = stroke.points[stroke.points.length - 1];
                const secondLastPoint = stroke.points[stroke.points.length - 2];
                ctx.quadraticCurveTo(
                    secondLastPoint.x,
                    secondLastPoint.y,
                    lastPoint.x,
                    lastPoint.y
                );
            }
            
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        
        function redrawCanvas() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            strokes.forEach(stroke => drawStroke(stroke));
        }
        
        function undo() {
            if (strokes.length > 0) {
                redoStack.push(strokes.pop());
                redrawCanvas();
            }
        }
        
        function redo() {
            if (redoStack.length > 0) {
                strokes.push(redoStack.pop());
                redrawCanvas();
            }
        }
        
        function clearCanvas() {
            strokes = [];
            redoStack = [];
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        
        function downloadImage(format) {
            const link = document.createElement('a');
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            link.download = `drawing_${timestamp}.${format}`;
            
            if (format === 'jpg' || format === 'jpeg') {
                // Create white background for JPG
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = canvas.width;
                tempCanvas.height = canvas.height;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.fillStyle = 'white';
                tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
                tempCtx.drawImage(canvas, 0, 0);
                link.href = tempCanvas.toDataURL('image/jpeg', 0.95);
            } else {
                link.href = canvas.toDataURL('image/png');
            }
            
            link.click();
            closeSaveMenu();
        }
        
        function saveSVG() {
            let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">`;
            svg += '<rect width="100%" height="100%" fill="white"/>';
            
            strokes.forEach(stroke => {
                if (stroke.points.length < 2) return;
                
                let pathData = `M ${stroke.points[0].x} ${stroke.points[0].y}`;
                
                for (let i = 1; i < stroke.points.length - 1; i++) {
                    const xc = (stroke.points[i].x + stroke.points[i + 1].x) / 2;
                    const yc = (stroke.points[i].y + stroke.points[i + 1].y) / 2;
                    pathData += ` Q ${stroke.points[i].x} ${stroke.points[i].y} ${xc} ${yc}`;
                }
                
                if (stroke.points.length > 1) {
                    const lastPoint = stroke.points[stroke.points.length - 1];
                    const secondLastPoint = stroke.points[stroke.points.length - 2];
                    pathData += ` Q ${secondLastPoint.x} ${secondLastPoint.y} ${lastPoint.x} ${lastPoint.y}`;
                }
                
                svg += `<path d="${pathData}" stroke="${stroke.color}" stroke-width="${stroke.size}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="${stroke.opacity}"/>`;
            });
            
            svg += '</svg>';
            
            const blob = new Blob([svg], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            link.download = `drawing_${timestamp}.svg`;
            link.href = url;
            link.click();
            URL.revokeObjectURL(url);
            closeSaveMenu();
        }
        
        function copyToClipboard() {
            canvas.toBlob(blob => {
                navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob })
                ]).then(() => {
                    showNotification();
                    closeSaveMenu();
                }).catch(err => {
                    alert('Failed to copy to clipboard');
                });
            });
        }
        
        function showNotification() {
            const notification = document.getElementById('notification');
            notification.classList.add('show');
            setTimeout(() => {
                notification.classList.remove('show');
            }, 1000);
        }
        
        function showSaveMenu() {
            document.getElementById('saveMenu').classList.add('show');
            document.getElementById('saveOverlay').classList.add('show');
        }
        
        function closeSaveMenu() {
            document.getElementById('saveMenu').classList.remove('show');
            document.getElementById('saveOverlay').classList.remove('show');
        }
        
        function closeAllMenus() {
            document.getElementById('penPopup').classList.remove('show');
            document.getElementById('highlighterPopup').classList.remove('show');
            document.getElementById('textPopup').classList.remove('show');
            document.getElementById('eraserPopup').classList.remove('show');
        }
        
        canvas.addEventListener('mousedown', startDrawing);
        canvas.addEventListener('mousemove', draw);
        canvas.addEventListener('mouseup', stopDrawing);
        canvas.addEventListener('mouseout', stopDrawing);
        
        canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            startDrawing(e);
        });
        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            draw(e);
        });
        canvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            stopDrawing();
        });
        
        let hoverTimeout;
        
        function positionMenu(menuId, buttonId) {
            const menu = document.getElementById(menuId);
            const button = document.getElementById(buttonId);
            const buttonRect = button.getBoundingClientRect();
            const menuWidth = menu.offsetWidth;
            
            // Center menu horizontally with the button
            const centerOffset = buttonRect.left + (buttonRect.width / 2) - (menuWidth / 2);
            
            // Position above the toolbar
            menu.style.left = centerOffset + 'px';
            menu.style.bottom = (window.innerHeight - buttonRect.top + 10) + 'px';
            menu.style.top = 'auto';
        }
        
        function showPenMenu() {
            clearTimeout(hoverTimeout);
            positionMenu('penPopup', 'penBtn');
            document.getElementById('penPopup').classList.add('show');
            document.getElementById('highlighterPopup').classList.remove('show');
        }
        
        function showHighlighterMenu() {
            clearTimeout(hoverTimeout);
            positionMenu('highlighterPopup', 'highlighterBtn');
            document.getElementById('highlighterPopup').classList.add('show');
            document.getElementById('penPopup').classList.remove('show');
        }
        
        function switchToPen() {
            currentTool = 'pen';
            document.getElementById('penBtn').classList.add('active');
            document.getElementById('highlighterBtn').classList.remove('active');
            document.getElementById('eraserBtn').classList.remove('active');
            document.getElementById('textBtn').classList.remove('active');
            canvas.className = 'pen-cursor';
        }
        
        function switchToHighlighter() {
            currentTool = 'highlighter';
            document.getElementById('highlighterBtn').classList.add('active');
            document.getElementById('penBtn').classList.remove('active');
            document.getElementById('eraserBtn').classList.remove('active');
            document.getElementById('textBtn').classList.remove('active');
            canvas.className = 'highlighter-cursor';
        }
        
        function showTextMenu() {
            clearTimeout(hoverTimeout);
            positionMenu('textPopup', 'textBtn');
            document.getElementById('textPopup').classList.add('show');
            document.getElementById('penPopup').classList.remove('show');
            document.getElementById('highlighterPopup').classList.remove('show');
        }
        
        function switchToText() {
            currentTool = 'text';
            document.getElementById('textBtn').classList.add('active');
            document.getElementById('penBtn').classList.remove('active');
            document.getElementById('highlighterBtn').classList.remove('active');
            document.getElementById('eraserBtn').classList.remove('active');
            canvas.className = 'text-cursor';
        }
        
        function switchToEraser() {
            currentTool = 'eraser';
            document.getElementById('eraserBtn').classList.add('active');
            document.getElementById('penBtn').classList.remove('active');
            document.getElementById('highlighterBtn').classList.remove('active');
            document.getElementById('textBtn').classList.remove('active');
            canvas.className = 'eraser-cursor';
        }
        
        function showEraserMenu() {
            clearTimeout(hoverTimeout);
            positionMenu('eraserPopup', 'eraserBtn');
            document.getElementById('eraserPopup').classList.add('show');
            document.getElementById('penPopup').classList.remove('show');
            document.getElementById('highlighterPopup').classList.remove('show');
            document.getElementById('textPopup').classList.remove('show');
        }
        
        function switchToText() {
            currentTool = 'text';
            document.getElementById('textBtn').classList.add('active');
            document.getElementById('penBtn').classList.remove('active');
            document.getElementById('highlighterBtn').classList.remove('active');
            document.getElementById('eraserBtn').classList.remove('active');
            canvas.className = 'text-cursor';
        }
        
        function switchToEraser() {
            currentTool = 'eraser';
            document.getElementById('eraserBtn').classList.add('active');
            document.getElementById('penBtn').classList.remove('active');
            document.getElementById('highlighterBtn').classList.remove('active');
            document.getElementById('textBtn').classList.remove('active');
            canvas.className = 'eraser-cursor';
        }
        
        function hideMenus() {
            hoverTimeout = setTimeout(() => {
                closeAllMenus();
            }, 100);
        }
        
        document.getElementById('penBtn').addEventListener('click', switchToPen);
        
        document.getElementById('penBtn').addEventListener('mouseenter', showPenMenu);
        document.getElementById('penBtn').addEventListener('mouseleave', hideMenus);
        
        document.getElementById('penPopup').addEventListener('mouseenter', () => {
            clearTimeout(hoverTimeout);
        });
        document.getElementById('penPopup').addEventListener('mouseleave', hideMenus);
        
        document.getElementById('highlighterBtn').addEventListener('click', switchToHighlighter);
        
        document.getElementById('highlighterBtn').addEventListener('mouseenter', showHighlighterMenu);
        document.getElementById('highlighterBtn').addEventListener('mouseleave', hideMenus);
        
        document.getElementById('highlighterPopup').addEventListener('mouseenter', () => {
            clearTimeout(hoverTimeout);
        });
        document.getElementById('highlighterPopup').addEventListener('mouseleave', hideMenus);
        
        document.getElementById('eraserBtn').addEventListener('click', switchToEraser);
        
        document.getElementById('eraserBtn').addEventListener('mouseenter', showEraserMenu);
        document.getElementById('eraserBtn').addEventListener('mouseleave', hideMenus);
        
        document.getElementById('eraserPopup').addEventListener('mouseenter', () => {
            clearTimeout(hoverTimeout);
        });
        document.getElementById('eraserPopup').addEventListener('mouseleave', hideMenus);
        
        document.getElementById('strokeEraserBtn').addEventListener('click', () => {
            eraserMode = 'stroke';
            switchToEraser();
            document.getElementById('strokeEraserBtn').classList.add('active');
            document.getElementById('pixelEraserBtn').classList.remove('active');
        });
        
        document.getElementById('pixelEraserBtn').addEventListener('click', () => {
            eraserMode = 'pixel';
            switchToEraser();
            document.getElementById('pixelEraserBtn').classList.add('active');
            document.getElementById('strokeEraserBtn').classList.remove('active');
        });
        
        document.getElementById('textBtn').addEventListener('click', () => {
            currentTool = 'text';
            document.getElementById('textBtn').classList.add('active');
            document.getElementById('penBtn').classList.remove('active');
            document.getElementById('highlighterBtn').classList.remove('active');
            document.getElementById('eraserBtn').classList.remove('active');
            canvas.className = 'text-cursor';
            closeAllMenus();
        });
        
        document.getElementById('textBtn').addEventListener('mouseenter', showTextMenu);
        document.getElementById('textBtn').addEventListener('mouseleave', hideMenus);
        
        document.getElementById('textPopup').addEventListener('mouseenter', () => {
            clearTimeout(hoverTimeout);
        });
        document.getElementById('textPopup').addEventListener('mouseleave', hideMenus);
        
        document.getElementById('fontSelect').addEventListener('change', (e) => {
            textFont = e.target.value;
            switchToText();
            if (isEditingText) {
                textInput.style.fontFamily = textFont;
            }
        });
        
        document.getElementById('textSizeSlider').addEventListener('input', (e) => {
            textSize = parseInt(e.target.value);
            switchToText();
            document.getElementById('textSizeValue').textContent = textSize;
            if (isEditingText) {
                textInput.style.fontSize = textSize + 'px';
            }
        });
        
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const menu = btn.dataset.menu;
                const color = btn.dataset.color;
                
                if (color) {
                    if (menu === 'pen') {
                        penColor = color;
                        switchToPen();
                        document.querySelectorAll('[data-menu="pen"]').forEach(b => b.classList.remove('active'));
                    } else {
                        highlighterColor = color;
                        switchToHighlighter();
                        document.querySelectorAll('[data-menu="highlighter"]').forEach(b => b.classList.remove('active'));
                    }
                    btn.classList.add('active');
                }
            });
        });
        
        document.getElementById('penColorPicker').addEventListener('click', () => {
            document.getElementById('penColorInput').click();
        });
        
        document.getElementById('penColorInput').addEventListener('input', (e) => {
            penColor = e.target.value;
            switchToPen();
            document.querySelectorAll('[data-menu="pen"]').forEach(b => b.classList.remove('active'));
            document.getElementById('penColorPicker').classList.add('active');
            document.getElementById('penColorPicker').style.background = penColor;
        });
        
        document.getElementById('highlighterColorPicker').addEventListener('click', () => {
            document.getElementById('highlighterColorInput').click();
        });
        
        document.getElementById('highlighterColorInput').addEventListener('input', (e) => {
            highlighterColor = e.target.value;
            switchToHighlighter();
            document.querySelectorAll('[data-menu="highlighter"]').forEach(b => b.classList.remove('active'));
            document.getElementById('highlighterColorPicker').classList.add('active');
            document.getElementById('highlighterColorPicker').style.background = highlighterColor;
        });
        
        document.getElementById('penSizeSlider').addEventListener('input', (e) => {
            penSize = parseInt(e.target.value);
            switchToPen();
            document.getElementById('penSizeValue').textContent = penSize;
        });
        
        document.getElementById('highlighterSizeSlider').addEventListener('input', (e) => {
            highlighterSize = parseInt(e.target.value);
            switchToHighlighter();
            document.getElementById('highlighterSizeValue').textContent = highlighterSize;
        });
        
        document.getElementById('highlighterOpacitySlider').addEventListener('input', (e) => {
            highlighterOpacity = parseInt(e.target.value) / 100;
            switchToHighlighter();
            document.getElementById('highlighterOpacityValue').textContent = e.target.value;
        });
        
        document.getElementById('undoBtn').addEventListener('click', undo);
        document.getElementById('redoBtn').addEventListener('click', redo);
        document.getElementById('clearBtn').addEventListener('click', clearCanvas);
        document.getElementById('saveBtn').addEventListener('click', showSaveMenu);
        
        document.getElementById('savePNG').addEventListener('click', () => downloadImage('png'));
        document.getElementById('saveJPG').addEventListener('click', () => downloadImage('jpg'));
        document.getElementById('saveSVG').addEventListener('click', saveSVG);
        document.getElementById('copyClipboard').addEventListener('click', copyToClipboard);
        document.getElementById('saveOverlay').addEventListener('click', closeSaveMenu);
        
        document.addEventListener('click', (e) => {
            const penPopup = document.getElementById('penPopup');
            const highlighterPopup = document.getElementById('highlighterPopup');
            const textPopup = document.getElementById('textPopup');
            const eraserPopup = document.getElementById('eraserPopup');
            const toolbar = document.getElementById('toolbar');
            
            if (!penPopup.contains(e.target) && 
                !highlighterPopup.contains(e.target) && 
                !textPopup.contains(e.target) &&
                !eraserPopup.contains(e.target) &&
                !toolbar.contains(e.target)) {
                closeAllMenus();
            }
        });
        
        // Keyboard shortcuts for undo/redo
        document.addEventListener('keydown', (e) => {
            // Check for Cmd (Mac) or Ctrl (Windows/Linux)
            if (e.metaKey || e.ctrlKey) {
                if (e.shiftKey && e.key.toLowerCase() === 'z') {
                    // Cmd/Ctrl + Shift + Z = Redo
                    e.preventDefault();
                    redo();
                } else if (e.key.toLowerCase() === 'z') {
                    // Cmd/Ctrl + Z = Undo
                    e.preventDefault();
                    undo();
                }
            }
        });